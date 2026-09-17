import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

const SRC_DIR = path.resolve(import.meta.dirname ?? __dirname, "src");
const CHECKSUMS_PATH = path.resolve(import.meta.dirname ?? __dirname, "checksums.json");
const CHECK_MODE = Bun.argv.includes("--check");

const TARGETS = [
  path.resolve(import.meta.dirname ?? __dirname, "..", "packages", "dsh-cohub", "src", "shared"),
  path.resolve(import.meta.dirname ?? __dirname, "..", "packages", "oh-my-opencode-cohub", "src", "shared"),
  path.resolve(import.meta.dirname ?? __dirname, "..", "packages", "zcode-cohub", "src", "shared"),
];

// 保留文件名黑名单：按目标包区分，防止覆盖目标包自身的独立文件。
// zcode-cohub 的 constants.ts 是包内既有合法文件，不属于共享集。
// dsh-cohub：fs-atomic / fs-json / token-estimator 无业务消费者，停同步。
// oh-my-opencode-cohub：fs-json 无业务消费者，停同步。
// zcode-cohub：chinese / token-estimator 无业务消费者，停同步。
const TARGET_RESERVED: Map<string, Set<string>> = new Map([
  [TARGETS[0], new Set(["fs-atomic.ts", "fs-json.ts", "token-estimator.ts"])],
  [TARGETS[1], new Set(["fs-json.ts"])],
  [TARGETS[2], new Set(["constants.ts", "chinese.ts", "token-estimator.ts"])],
]);

function isReserved(targetDir: string, filename: string): boolean {
  return TARGET_RESERVED.get(targetDir)?.has(filename) ?? false;
}

type Checksums = Record<string, string>;

// 行尾归一化：CRLF → LF，确保哈希计算与平台行尾解耦。
// checksums.json 中记录的是 LF 形态的哈希，归一化后直接可比对。
function sha256(data: string): string {
  return crypto.createHash("sha256").update(data.replace(/\r\n/g, "\n"), "utf-8").digest("hex");
}

function loadChecksums(): Checksums {
  if (!fs.existsSync(CHECKSUMS_PATH)) return {};
  return JSON.parse(fs.readFileSync(CHECKSUMS_PATH, "utf-8")) as Checksums;
}

function saveChecksums(cs: Checksums): void {
  fs.writeFileSync(CHECKSUMS_PATH, JSON.stringify(cs, null, 2) + "\n", "utf-8");
}

function generateHeader(sourceFilename: string): string {
  return [
    `// ⚠️ 本文件由 cohub-shared/src/${sourceFilename} 自动同步生成，请勿直接编辑。`,
    `// 修改请改 cohub-shared/src/${sourceFilename}，然后运行 bun cohub-shared/sync.ts`,
    "",
  ].join("\n");
}

function getSourceFiles(): string[] {
  return fs.readdirSync(SRC_DIR)
    .filter(f => f.endsWith(".ts") && f !== "index.ts" && !f.endsWith(".test.ts") && !f.endsWith(".spec.ts"))
    .sort();
}

function main(): void {
  const sourceFiles = getSourceFiles();
  const oldChecksums = loadChecksums();
  const newChecksums: Checksums = {};
  const drifts: string[] = [];

  // 读取所有源文件，为每个文件预计算「目标内容 = 头部 + 源内容」及其期望哈希。
  // checksums 记录的是目标文件的期望哈希，不是源文件哈希。
  const sources: Map<string, { srcContent: string; targetContent: string; expectedHash: string }> = new Map();
  for (const f of sourceFiles) {
    const srcContent = fs.readFileSync(path.join(SRC_DIR, f), "utf-8");
    const header = generateHeader(f);
    const targetContent = header + srcContent;
    const expectedHash = sha256(targetContent);
    sources.set(f, { srcContent, targetContent, expectedHash });
    newChecksums[f] = expectedHash;
  }

  let syncedCount = 0;
  let syncErrors: string[] = [];
  let reservedSkips: string[] = [];

  for (const targetDir of TARGETS) {
    const pkgName = path.basename(path.dirname(path.dirname(targetDir)));

    if (!fs.existsSync(targetDir)) {
      if (!CHECK_MODE) fs.mkdirSync(targetDir, { recursive: true });
    }

    for (const f of sourceFiles) {
      const src = sources.get(f)!;
      const targetPath = path.join(targetDir, f);

      // 保留文件名黑名单：命中时跳过，不覆盖目标包自有文件
      if (isReserved(targetDir, f)) {
        reservedSkips.push(`${pkgName}/src/shared/${f}`);
        continue;
      }

      const exists = fs.existsSync(targetPath);

      if (exists) {
        const existingContent = fs.readFileSync(targetPath, "utf-8");
        const existingHash = sha256(existingContent);

        if (existingHash === src.expectedHash) {
          // 已经是最新，无需操作
          continue;
        }

        // 漂移：目标文件哈希不等于期望值
        const oldHash = oldChecksums[f];
        if (oldHash !== undefined && existingHash !== oldHash) {
          drifts.push(`${pkgName}/src/shared/${f}`);
        }
      }

      if (CHECK_MODE) {
        if (!exists || sha256(fs.readFileSync(targetPath, "utf-8")) !== src.expectedHash) {
          drifts.push(`${pkgName}/src/shared/${f} (未同步或内容不一致)`);
        }
        continue;
      }

      try {
        fs.writeFileSync(targetPath, src.targetContent, "utf-8");
        syncedCount++;
      } catch (e: any) {
        syncErrors.push(`写入 ${targetPath} 失败: ${e.message}`);
      }
    }
  }

  // 打印结果
  if (CHECK_MODE) {
    if (drifts.length > 0) {
      console.log(`⚠️  漂移检测：发现 ${drifts.length} 处差异：`);
      drifts.forEach(d => console.log(`  - ${d}`));
      process.exit(1);
    }
    if (reservedSkips.length > 0) {
      console.log(`ℹ️  保留文件跳过（${reservedSkips.length} 处）：`);
      reservedSkips.forEach(s => console.log(`  - ${s}`));
    }
    console.log(`✅ 无漂移 — 共 ${sourceFiles.length} 个文件，${TARGETS.length} 个目标包，全部一致`);
    process.exit(0);
  }

  // 写入模式
  if (drifts.length > 0) {
    console.log(`⚠️  漂移警告（${drifts.length} 处）：`);
    drifts.forEach(d => console.log(`  - ${d}`));
    console.log("  已用共享源覆盖。");
  }

  if (reservedSkips.length > 0) {
    console.log(`ℹ️  保留文件跳过（${reservedSkips.length} 处）：`);
    reservedSkips.forEach(s => console.log(`  - ${s}`));
  }

  if (syncErrors.length > 0) {
    syncErrors.forEach(e => console.error(e));
    process.exit(1);
  }

  saveChecksums(newChecksums);
  console.log(`✅ 同步完成 — ${sourceFiles.length} 个文件 → ${TARGETS.length} 个包${drifts.length > 0 ? `（${drifts.length} 处漂移已修复）` : ""}${reservedSkips.length > 0 ? `（${reservedSkips.length} 处保留跳过）` : ""}`);
}

main();