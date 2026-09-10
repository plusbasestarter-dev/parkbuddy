import {readFile,readdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
const root=new URL('../',import.meta.url);
const html=await readFile(new URL('index.html',root),'utf8');
const files=['index.html','sw.js'];
async function walk(dir){for(const e of await readdir(new URL(dir,root),{withFileTypes:true})){if(e.isDirectory())await walk(dir+e.name+'/');else files.push(dir+e.name);}}
await walk('assets/');
for(const file of files){assert.deepEqual(await readFile(new URL(file,root)),await readFile(new URL('frontend/'+file,root)),`Frontend mirror differs: ${file}`);if(/\.(mjs|js)$/.test(file)){const r=spawnSync(process.execPath,['--check',new URL(file,root).pathname],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);}}
for(const [,url] of html.matchAll(/(?:src|href)="(assets\/[^"?]+)[^"]*"/g))await readFile(new URL(url,root));
assert.ok(!html.includes('onclick='),'Use delegated event handling');
console.log('PASS entrypoints, mirrored assets and JavaScript syntax ('+files.length+' files)');
