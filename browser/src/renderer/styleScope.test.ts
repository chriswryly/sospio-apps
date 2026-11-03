import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import postcss from "postcss";
describe('legacy styles remain in Operator',()=>{
 it('has no bare element selectors that leak into chat or cockpit',()=>{
  const css=postcss.parse(readFileSync(new URL('./styles.css',import.meta.url),'utf8'));
  const bad:string[]=[];
  css.walkRules(rule=>{for(const selector of rule.selectors){
   if (/^(details|summary|strong|p|button|pre|textarea|select)(?:\b|:)/.test(selector))bad.push(selector);
  }});
  expect(bad).toEqual([]);
 });
});
