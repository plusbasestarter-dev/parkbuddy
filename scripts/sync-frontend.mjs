import {copyFile,cp} from 'node:fs/promises';
// GitHub Pages serves the root; the existing Python deployment serves frontend/.
// Keep one authored application and generate the second entrypoint from it.
await copyFile(new URL('../index.html',import.meta.url),new URL('../frontend/index.html',import.meta.url));
await copyFile(new URL('../sw.js',import.meta.url),new URL('../frontend/sw.js',import.meta.url));
await cp(new URL('../assets/',import.meta.url),new URL('../frontend/assets/',import.meta.url),{recursive:true});
