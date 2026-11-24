'use strict';
// Applies only after a failed recovery. It never moves a schedule's nextAt.
module.exports=function createBackoff({now=Date.now}={}){
 const owners=new Map();
 return {
  paused(owner){return (owners.get(owner)?.until||0)>now();},
  fail(owner,error,previous=0){const old=owners.get(owner),attempt=Math.min(5,previous+1),level=Math.min(20,Math.max(previous,old?.level||0)+1);const advised=Number(error?.retryAfterMs)||0;
   const delay=Math.max(advised,error?.status===401?30*60000:Math.min(30*60000,60000*2**Math.min(level-1,5)));const until=now()+delay;owners.set(owner,{level,until});return {attempt,until};},
  connected(owner){owners.delete(owner);}
 };
};
