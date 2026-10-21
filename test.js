const solc=require('solc'),fs=require('fs'),path=require('path');
const ganache=require('ganache'),{ethers}=require('ethers');
function build(){
 const sources={'MilestoneVault.sol':{content:fs.readFileSync('MilestoneVault.sol','utf8')},'Mock.sol':{content:fs.readFileSync('Mock.sol','utf8')}};
 const imp=p=>{try{return{contents:fs.readFileSync(path.join('node_modules',p),'utf8')}}catch(e){return{error:'nf'}}};
 const o=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',sources,settings:{evmVersion:'shanghai',optimizer:{enabled:true,runs:200},outputSelection:{'*':{'*':['abi','evm.bytecode.object']}}}}),{import:imp}));
 (o.errors||[]).filter(e=>e.severity==='error').forEach(e=>{throw new Error(e.formattedMessage)});
 return o.contracts;
}
const C=build();
const U=n=>ethers.parseUnits(String(n),18);
let pass=0,fail=0; const gas={};
function ok(c,m){ if(c){pass++;console.log('  PASS',m)} else {fail++;console.log('  FAIL',m)} }
async function reverts(p,m){ try{ await (await p).wait?.(); }catch(e){ pass++;console.log('  PASS',m,'(reverts)');return } fail++;console.log('  FAIL',m,'(did not revert)'); }
async function rec(name,tx){const r=await (await tx).wait(); gas[name]=Math.max(gas[name]||0,Number(r.gasUsed)); return r;}

async function setup(opts={}){
 const prov=new ethers.BrowserProvider(ganache.provider({logging:{quiet:true},chain:{vmErrorsOnRPCResponse:true},wallet:{totalAccounts:8,defaultBalance:1000}}));
 const s=await Promise.all([0,1,2,3,4,5].map(i=>prov.getSigner(i)));
 prov.estimateGas=async()=>3000000n; prov.pollingInterval=50;
 const [creator,alice,bob,arbiter,guardian,mallory]=s;
 const f=(n)=>new ethers.ContractFactory(C[n+'.sol'][n==='MilestoneVault'?'MilestoneVault':'MockUSDC'].abi,C[n+'.sol'][n==='MilestoneVault'?'MilestoneVault':'MockUSDC'].evm.bytecode.object,creator);
 const tok=await (await f('Mock').deploy()).waitForDeployment();
 for(const a of [creator,alice,bob,mallory]) await (await tok.mint(await a.getAddress(),U(10000))).wait();
 const now=(await prov.getBlock('latest')).timestamp;
 const cfg={token:await tok.getAddress(),creator:await creator.getAddress(),arbiter:await arbiter.getAddress(),guardian:await guardian.getAddress(),
  goal:U(1000),bond:U(100),challengeBond:U(10),fundingDeadline:now+86400,challengeWindow:3*86400,grace:2*86400};
 const bps=opts.bps||[1500,2500,3000,3000];
 const v=await (await f('MilestoneVault').deploy(cfg,bps,[7,7,7,7].map(d=>d*86400),bps.map((_,i)=>ethers.id('crit'+i)))).waitForDeployment();
 const addr=await v.getAddress();
 for(const a of [creator,alice,bob,mallory]) await (await tok.connect(a).approve(addr,U(10000))).wait();
 const t=async d=>{await prov.send('evm_increaseTime',[d]);await prov.send('evm_mine',[])};
 return {prov,v,tok,creator,alice,bob,arbiter,guardian,mallory,t,addr};
}
async function fund(E){
 await rec('postBond',E.v.connect(E.creator).postBond());
 await rec('donate',E.v.connect(E.alice).donate(U(600)));
 await E.v.connect(E.bob).donate(U(400));
 await rec('finalizeFunding',E.v.finalizeFunding());
}
(async()=>{
 const G=process.argv[2];
 if(G==='1'){ console.log('T1 happy path: 4 milestones, optimistic release');
 let E=await setup(); await fund(E);
 for(let i=0;i<4;i++){ await rec('submitMilestone',E.v.connect(E.creator).submitMilestone(ethers.id('ev'+i)));
  await reverts(E.v.release(),'release blocked inside challenge window (M'+(i+1)+')');
  await E.t(3*86400+10); await rec('release',E.v.release()); }
 ok(Number(await E.v.state())===3,'state == COMPLETE');
 await rec('withdraw',E.v.connect(E.creator).withdraw());
 const cb=await E.tok.balanceOf(await E.creator.getAddress());
 ok(cb===U(10000+1000),'creator received exactly 1000 (bond returned, net +1000)');
 ok((await E.tok.balanceOf(E.addr))===0n,'vault empty after completion');

 }
 if(G==='2'){ console.log('T2 fraud: M1 unchallenged, M2 challenged and rejected -> pro-rata refund + bond forfeit');
 E=await setup(); await fund(E);
 await E.v.connect(E.creator).submitMilestone(ethers.id('a')); await E.t(3*86400+10); await E.v.release();
 await E.v.connect(E.creator).submitMilestone(ethers.id('fake'));
 await rec('challenge',E.v.connect(E.alice).challenge());
 await reverts(E.v.connect(E.mallory).resolve(0),'non-arbiter cannot resolve');
 console.log('  ..resolving'); await rec('resolve',E.v.connect(E.arbiter).resolve(0)); console.log('  ..resolved');
 ok(Number(await E.v.state())===2,'state == REFUNDING');
 ok((await E.v.refundPool())===U(950),'refund pool = 1000-150 released + 100 bond = 950');
 console.log('  ..claiming'); const a0=await E.tok.balanceOf(await E.alice.getAddress()); await rec('claimRefund',E.v.connect(E.alice).claimRefund());
 const b0=await E.tok.balanceOf(await E.bob.getAddress()); await E.v.connect(E.bob).claimRefund();
 ok((await E.tok.balanceOf(await E.alice.getAddress()))-a0===U(570),'Alice refund = 570 (60% of 950)');
 ok((await E.tok.balanceOf(await E.bob.getAddress()))-b0===U(380),'Bob refund = 380 (40% of 950)');
 await reverts(E.v.connect(E.alice).claimRefund(),'double refund blocked');
 await E.v.connect(E.alice).withdraw(); // challenger bond back
 await E.v.connect(E.creator).withdraw(); // 150 released for M1
 ok((await E.tok.balanceOf(E.addr))===0n,'conservation: vault balance == 0 after all claims');

 }
 if(G==='3'){ console.log('T3 partial completion: arbiter awards 50% of M1');
 E=await setup(); await fund(E);
 await E.v.connect(E.creator).submitMilestone(ethers.id('p')); await E.v.connect(E.bob).challenge();
 await E.v.connect(E.arbiter).resolve(5000);
 ok((await E.v.totalReleased())===U(75),'released 75 of 150 tranche');
 for(let i=1;i<4;i++){ await E.v.connect(E.creator).submitMilestone(ethers.id('q'+i)); await E.t(3*86400+10); await E.v.release(); }
 ok(Number(await E.v.state())===3,'COMPLETE after remaining milestones');
 ok((await E.v.refundPool())===U(75),'unreleased remainder (75) refundable to backers');
 await E.v.connect(E.alice).claimRefund(); await E.v.connect(E.bob).claimRefund();

 }
 if(G==='4'){ console.log('T4 lapse: creator misses deadline');
 E=await setup(); await fund(E);
 await reverts(E.v.lapse(),'lapse too early blocked');
 await E.t(7*86400+2*86400+10); await rec('lapse',E.v.lapse());
 ok(Number(await E.v.state())===2,'REFUNDING after lapse');
 ok((await E.v.refundPool())===U(1100),'refund pool = 1000 + 100 forfeited bond');

 }
 if(G==='5'){ console.log('T5 safety checks');
 E=await setup(); await fund(E);
 await E.v.connect(E.creator).submitMilestone(ethers.id('x'));
 await reverts(E.v.connect(E.mallory).challenge(),'non-backer cannot challenge');
 await E.v.connect(E.guardian).setReleasesPaused(true);
 await E.t(3*86400+10);
 await reverts(E.v.release(),'release blocked while paused');
 await reverts(E.v.connect(E.alice).setReleasesPaused(false),'only guardian can pause');
 await E.v.connect(E.guardian).setReleasesPaused(false);
 await E.v.release();
 const E2=await setup();
 await reverts(E2.v.connect(E2.creator).donate(U(1)),'donate before bond posted blocked');
 await E2.v.connect(E2.creator).postBond();
 await reverts(E2.v.connect(E2.creator).donate(U(1)),'creator cannot self-fund (no vote/refund gaming)');
 await E2.v.connect(E2.alice).donate(U(100)); await E2.t(86400+10);
 await E2.v.finalizeFunding(); ok(Number(await E2.v.state())===2,'goal missed -> REFUNDING');
 await E2.v.connect(E2.alice).claimRefund(); ok((await E2.tok.balanceOf(await E2.alice.getAddress()))===U(10000),'backer fully refunded when goal missed');
 let bad=false; try{ await setup({bps:[2000,2000,3000,3000]}) }catch(e){bad=true}
 ok(bad,'constructor rejects first tranche > 15%');
 bad=false; try{ await setup({bps:[1000,2000,3000,3000]}) }catch(e){bad=true}
 ok(bad,'constructor rejects tranches not summing to 100%');

 }
 console.log('\nRESULT:',pass,'passed,',fail,'failed');
 console.log('GAS (max observed):',JSON.stringify(gas));
 fs.writeFileSync('res_'+G+'.json',JSON.stringify({pass,fail,gas},null,1));
 process.exit(fail?1:0);
})().catch(e=>{console.error(e);process.exit(1)});
