/* 生成 figma/plugin/code.js：把 customer-management.screen.json 嵌入为 SCREEN 常量。
   构建器逻辑已抽到 ./build_code.js（被命令行与网页编辑器共用）。
   运行：node figma/gen_plugin.js */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCodeJs } from './build_code.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const screen = fs.readFileSync(path.join(__dirname, 'customer-management.screen.json'), 'utf8');
const screenObj = JSON.parse(screen); // 提前校验 JSON 合法性

const out = buildCodeJs(screenObj);
fs.writeFileSync(path.join(__dirname, 'plugin', 'code.js'), out);
console.log('code.js written, bytes =', out.length);
