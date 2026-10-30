'use strict';
const catalogue=require('./italian-locations.json');
const provinces=new Map(catalogue.provinces.map(p=>[p.id,p]));
const municipalities=new Map(catalogue.provinces.flatMap(p=>p.municipalities.map(m=>[m.id,{...m,provinceCode:p.id,province:p.name,abbr:p.abbr}])));
const invalid=message=>Object.assign(new Error(message),{status:400,code:'invalid_location'});
function resolve(id){
 if(typeof id!=='string'||!/^\d{6}$/.test(id)||!municipalities.has(id))throw invalid('Seleziona un comune valido dall’elenco.');
 const m=municipalities.get(id);
 return {municipalityId:m.id,provinceCode:m.provinceCode,name:m.name+(m.abbr?' ('+m.abbr+')':''),latitude:m.latitude,longitude:m.longitude};
}
function query(input={}){
 const common={ok:true,version:catalogue.version,source:catalogue.source,license:catalogue.license};
 if(input.province!==undefined){
  if(typeof input.province!=='string'||!provinces.has(input.province))throw invalid('Seleziona una provincia valida.');
  const p=provinces.get(input.province);
  return {...common,province:{id:p.id,name:p.name,abbr:p.abbr,region:p.region},municipalities:p.municipalities};
 }
 return {...common,provinces:catalogue.provinces.map(({municipalities,...p})=>p)};
}
module.exports={resolve,query};
