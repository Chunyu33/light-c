/**
 * 生成 Windows ICO 文件
 */

import pngToIco from 'png-to-ico';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const iconsDir = path.join(__dirname, '../src-tauri/icons');

async function generateIco() {
  console.log('生成 Windows ICO 文件...');
  
  // 使用多个尺寸的PNG生成ICO
  const pngFiles = [
    path.join(iconsDir, '32x32.png'),
    path.join(iconsDir, '128x128.png'),
    path.join(iconsDir, '128x128@2x.png'),
  ];
  
  const icoBuffer = await pngToIco(pngFiles);
  fs.writeFileSync(path.join(iconsDir, 'icon.ico'), icoBuffer);
  
  console.log('✓ 生成 icon.ico');
}

generateIco().catch(console.error);
