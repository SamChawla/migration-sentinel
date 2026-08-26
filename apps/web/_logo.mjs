import sharp from "sharp";
const src = "E:/hackathon/migrationsentinel/migration-sentinel/ChatGPT Image Aug 25, 2026, 06_38_00 PM.png";
const m = await sharp(src).metadata();
console.log("dims", m.width, m.height, "alpha", m.hasAlpha);
