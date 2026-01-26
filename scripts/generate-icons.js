/**
 * 图标生成脚本
 * 使用 sharp 库将 SVG 转换为各种尺寸的 PNG
 * 
 * 使用方法:
 * 1. npm install sharp --save-dev
 * 2. node scripts/generate-icons.js
 */

import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const iconsDir = path.join(__dirname, '../src-tauri/icons');
const svgPath = path.join(iconsDir, 'icon.svg');

// Tauri 需要的图标尺寸
const sizes = [
  { name: '32x32.png', size: 32 },
  { name: '128x128.png', size: 128 },
  { name: '128x128@2x.png', size: 256 },
  { name: 'icon.png', size: 512 },
  // Windows Store 图标
  { name: 'Square30x30Logo.png', size: 30 },
  { name: 'Square44x44Logo.png', size: 44 },
  { name: 'Square71x71Logo.png', size: 71 },
  { name: 'Square89x89Logo.png', size: 89 },
  { name: 'Square107x107Logo.png', size: 107 },
  { name: 'Square142x142Logo.png', size: 142 },
  { name: 'Square150x150Logo.png', size: 150 },
  { name: 'Square284x284Logo.png', size: 284 },
  { name: 'Square310x310Logo.png', size: 310 },
  { name: 'StoreLogo.png', size: 50 },
];

async function generateIcons() {
  console.log('开始生成图标...\n');

  // 读取 SVG 文件
  const svgBuffer = fs.readFileSync(svgPath);

  for (const { name, size } of sizes) {
    const outputPath = path.join(iconsDir, name);
    
    await sharp(svgBuffer)
      .resize(size, size)
      .png()
      .toFile(outputPath);
    
    console.log(`✓ 生成 ${name} (${size}x${size})`);
  }

  console.log('\n所有图标生成完成！');
  console.log('\n注意: icon.ico 和 icon.icns 需要使用专门的工具生成:');
  console.log('- Windows ICO: 可以使用 https://icoconvert.com/');
  console.log('- macOS ICNS: 可以使用 iconutil 或在线工具');
}

generateIcons().catch(console.error);
