const solc=require('solc'),fs=require('fs'),path=require('path');
const src=fs.readFileSync('MilestoneVault.sol','utf8');
const input={language:'Solidity',sources:{'MilestoneVault.sol':{content:src}},
 settings:{optimizer:{enabled:true,runs:200},outputSelection:{'*':{'*':['abi','evm.bytecode.object','evm.deployedBytecode.object']}}}};
function imp(p){try{return{contents:fs.readFileSync(path.join('node_modules',p),'utf8')}}catch(e){return{error:'nf '+p}}}
const out=JSON.parse(solc.compile(JSON.stringify(input),{import:imp}));
let err=0;(out.errors||[]).forEach(e=>{console.log(e.severity+': '+e.formattedMessage.split('\n')[0]);if(e.severity==='error')err++});
if(!err){const c=out.contracts['MilestoneVault.sol'].MilestoneVault;
 console.log('COMPILED OK. runtime bytecode bytes:',c.evm.deployedBytecode.object.length/2);
 fs.writeFileSync('MilestoneVault.abi.json',JSON.stringify(c.abi,null,1));}
