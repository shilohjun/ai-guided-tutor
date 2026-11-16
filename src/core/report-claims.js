/** Report-only parsing: retain clause boundaries and the direction of negation.
 * Unknown expressions revoke an earlier verdict; they are not silently accepted.
 */
import {canonicalize} from './text.js';
export function conceptText(text) {
  return canonicalize(String(text??'')).replace(/合外力/g,'合力').replace(/牵引力/g,'拉力').replace(/\s+/g,'');
}
export function conceptStatements(raw) {
  return String(raw??'')
    .replace(/[，,](?=(?:但|但是|不过)?(?:我)?(?:不确定|不知道|不会|不懂|想问))/g,'；')
    .split(/[；;。\n]|(?<!\d)\.(?!\d)/).map(s=>s.trim()).filter(Boolean);
}

const deniedBefore=/(?:不是|并非|不应(?:该)?是|不能用|不用|不等于|不采用|不认可|不该用)$/;
const deniedAfter=/^(?:这个公式|这一式|这个式子|这个关系|这)?(?:是错的|不成立|不能用|不正确|不对|不适用)/;
/** Narrow reviewed formula family. No arbitrary symbolic equivalence is inferred. */
export function checkpointFormula(id,raw) {
  const symbol=id==='work-formula'?'W':id==='power-average'?'P':null;
  if(!symbol)return null;
  const text=conceptText(raw);
  const re=new RegExp(`(?<![A-Za-z])${symbol}=([A-Za-zΔθα0-9_+*/×·()²³^.-]+)`,'g');
  const events=[];
  for(const m of text.matchAll(re)) {
    const expr=m[1].replace(/[×·]/g,'*');
    // A numeric answer alone is not evidence of a conceptual relationship.
    if(/^[+-]?\d/.test(expr))continue;
    const negated=deniedBefore.test(text.slice(0,m.index))||deniedAfter.test(text.slice(m.index+m[0].length));
    if(negated){events.push({result:'unverified',retracted:true});continue;}
    let correct=false,wrong=false;
    if(symbol==='P') {
      correct=/^W\/(?:t|Δt)$/.test(expr);
      wrong=/^(?:W\*?t|t\/W|W[+-]t|W\/t[²³])$/.test(expr);
    } else {
      correct=/^F\*?s(?:\*?cos(?:[θα]|\([θα]\)))?$/.test(expr);
      wrong=/^(?:F\/s|s\/F|F[+-]s|F\*?s[²³])$/.test(expr);
      const angle=text.match(/夹角(?:为|是|=)?(\d+(?:\.\d+)?)(?:度|°)/);
      if(/^F\*?s$/.test(expr)&&(/(?:并不|并非|不是|不|非)同向/.test(text)||(angle&&Number(angle[1])!==0))) {correct=false;wrong=true;}
    }
    events.push({result:correct?'correct':wrong?'incorrect':'unverified',retracted:false});
  }
  if(!events.length)return null;
  // “不是X，而是Y” selects Y. Other incompatible claims remain unresolved.
  if(/而是|改为|改成|更正为|现在应为/.test(text))return events.at(-1);
  if(new Set(events.map(e=>e.result)).size>1)return {result:'unverified',retracted:false};
  return events.at(-1);
}
