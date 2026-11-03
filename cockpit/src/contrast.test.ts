import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RECEIPTS } from "./vocabulary";
const css=readFileSync(new URL('./tokens.css', import.meta.url),'utf8');
const tokens=Object.fromEntries([...css.matchAll(/--([\w-]+):\s*oklch\(([^)]+)\)/g)].map(m=>[m[1],m[2].split(/\s+/).map(Number)]));
function luminance([L,C,h]:number[]):number {
 const a=C*Math.cos(h*Math.PI/180),b=C*Math.sin(h*Math.PI/180);
 const l=(L+.3963377774*a+.2158037573*b)**3,m=(L-.1055613458*a-.0638541728*b)**3,s=(L-.0894841775*a-1.291485548*b)**3;
 const rgb=[4.0767416621*l-3.3077115913*m+.2309699292*s,-1.2684380046*l+2.6097574011*m-.3413193965*s,-.0041960863*l-.7034186147*m+1.707614701*s].map(x=>Math.max(0,Math.min(1,x)));
 return .2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2];
}
const ratio=(a:number[],b:number[])=>{const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
describe('chat and cockpit text contrast',()=>{
 const pairs:[string,string][]=[];
 for(const fg of ['ink','muted','body'])for(const bg of ['paper','bg','user-bubble','syc-tint','ovr-tint','blue-tint','red-tint','countdown'])pairs.push([fg,bg]);
 for(const signal of ['syc','ovr'])pairs.push([signal,signal+'-tint'],['white',signal]);
 pairs.push(['blue','blue-tint'],['white','blue']);
 pairs.push(['clear','paper'],['paper','ink'],['red','paper']);
 for(const receipt of Object.values(RECEIPTS))pairs.push([receipt.fg,receipt.bg]);
 tokens.white=[1,0,0];tokens.hatchDark=[.925,.004,260];
 for(const fg of ['ink','muted','body'])pairs.push([fg,'hatchDark']);
 it.each(pairs)('%s on %s meets 4.5:1',(fg,bg)=>expect(ratio(tokens[fg],tokens[bg])).toBeGreaterThanOrEqual(4.5));
});
