# SDRF Wizard 规范合规修复计划

## Context

用户以 https://sdrf.quantms.org/specification.html（当前规范版本 **v1.1.0**）为标准，对 `sdrf-wizard` 做了一轮对照审查，发现向导生成的 SDRF 存在若干与规范不一致的问题。本计划将这些问题整理为可执行的修复清单。

审查范围：`src/app/components/sdrf-wizard/**`、`src/app/core/services/wizard-generator.service.ts`、`src/app/core/services/wizard-state.service.ts`、`src/app/core/models/wizard.ts`、`src/app/core/services/template.service.ts`。

对照标准：规范网页 + 当前 `bigbio/sdrf-pipelines` 校验器 + `bigbio/sdrf-templates`（GitHub，模板版本 1.0.0/1.1.0，manifest 在 `templates.yaml`，单模板在 `<name>/<version>/<name>.yaml`）。

## 已确认的范围决策

- **A. 范围 = 全部（c）**：高 + 中 + 低优先级 + 推荐列，全部纳入本期。
- **B. 版本 = 动态读取**：从 `bigbio/sdrf-templates` 的 `base` 模板版本动态获取当前规范版本，离线/失败回退到 `1.1.0`。
- **C. annotation tool = `sdrfedit v0.1.0`**（`name vX.Y.Z` 格式）。
- **D. 推荐列 = 做**：包括 `comment[...]` 技术类推荐列（dissociation method、mass tolerance、DIA scan windows、single-cell/crosslinking 推荐列等）。`characteristics[...]` 推荐列已由 Step 2 动态流程覆盖，仅需验证。

## Approach（总体思路）

所有修复集中在数据模型、模板服务与生成器层，复用现有「动态列」架构，不重写向导交互：

1. 修正规范版本来源：新增 `TemplateService.getSpecVersion()`，从 manifest 的 `base.latest` 动态读取，`SDRF_SPEC_VERSION` 降级为回退常量 `'1.1.0'`。
2. 修正列名 `strain/breed` → `strain or breed`（全库替换）。
3. 修正 multiplex 的 `assay name`：按 run 共享，而非按通道拼接。
4. 补齐 `characteristics[pooled sample]` 列。
5. 数据文件元数据列顺序对齐规范 canonical 顺序。
6. 补齐 provenance 与小字段（annotation tool、sex `intersex`、age 比较符/`pooled`、cleavage 兜底值）。
7. 推荐列：
   - `characteristics[...]` 推荐列（cell type / ancestry category / individual / cellosaurus name / passage number / culture medium / cells per well / mhc typing / antibody enrichment / enrichment process 等）——已由 Step 2 动态流程覆盖，**验证并补漏**。
   - `comment[...]` 推荐列（dissociation method / precursor mass tolerance / fragment mass tolerance / DIA scan windows / single-cell 的 carrier/reference channel、sample preparation batch / crosslinking 的 cross-linking coupled with ms、collision energy、crosslink enrichment method 等）——**新增动态采集与生成机制**。

## Files to modify

- `src/app/core/models/wizard.ts` — 常量、类型、`WizardExpansionRow`、helper、sex/age 取值
- `src/app/core/services/template.service.ts` — 新增 `getSpecVersion()`、`getWizardCommentColumns()`
- `src/app/core/services/wizard-generator.service.ts` — 生成器主逻辑（版本、列名、assay name、pooled sample、列顺序、推荐 comment 列）
- `src/app/core/services/wizard-state.service.ts` — 状态同步（strain/breed 重命名、comment 默认值状态）
- `src/app/components/sdrf-wizard/steps/instrument-protocol.component.ts` — 新增「推荐技术元数据」输入区（推荐 comment 列 UI）
- `src/app/components/sdrf-age-input/sdrf-age-input.component.ts` — age 比较运算符支持
- `src/app/core/services/llm/prompt.service.ts` — prompt 示例列名（strain/breed 重命名）

## Reuse（可复用）

- `src/app/core/models/wizard.ts`
  - `WizardExpansionRow`（扩展字段）、`resolveChannelSourceName()`、`buildWizardExpansionRows()`、`formatSdrfSemver()`
  - `DynamicColumnDefault` + `upsertDynamicColumnDefault()`（用于 comment 推荐列默认值，与 characteristics 同构）
  - `materializeSampleFieldsFromChoices()` / `buildModifiersFromExpansion()`（复用 modifier 折叠）
- `src/app/core/services/template.service.ts`
  - `fetchTemplates()` / `_manifest()` / `getTemplateVersion(name)` / `getResolvedTemplate(name)` / `getWizardCharacteristicColumns()`（新增 comment 版可仿照此实现）
- `src/app/core/services/sdrf-syntax.service.ts` — `POOLED_SAMPLE_VALUES`、age/modification 语法解析（供 age 比较符参考）
- `src/app/core/services/ols.service.ts` / `unimod.service.ts` — 推荐列 ontology/UNIMOD 搜索（Step 5 已有）
- 编辑器侧 `characteristics[pooled sample]` 元数据（`src/app/core/models/sdrf-config.ts`）与 `sdrf-export.service.ts` 的 pool 行处理，语义一致可对齐。

## Steps

### Step 1 — 规范版本动态读取（问题 #1）
- [ ] `template.service.ts` 新增 `getSpecVersion(): string`：优先 `this._manifest()?.templates['base']?.latest`；否则 `this._templates().get('base')?.version`；两者都不是合法 semver 时回退 `'1.1.0'`。
- [ ] `wizard.ts`：`SDRF_SPEC_VERSION` 改为 `'1.1.0'`（作为回退常量，语义更新注释）。
- [ ] `wizard-generator.service.ts` `createSdrfVersionColumn()`：改用 `formatSdrfSemver(this.templateService.getSpecVersion())`。
- [ ] `createSdrfTemplateColumns()` 的版本回退由 `SDRF_SPEC_VERSION` 改为 `this.templateService.getSpecVersion()`。
- [ ] `review-create.component.ts` L581 `sdrfVersion` 改为 `formatSdrfSemver(this.templateService.getSpecVersion())`（注入 TemplateService）。
- [ ] 验证：`comment[sdrf version]` 与 `comment[sdrf template]` 版本一致（均来自 manifest，v1.1.0）。

### Step 2 — 列名 `strain/breed` → `strain or breed`（问题 #2）
- [ ] `wizard.ts`：`SpecialtyCharacteristicKey` 与 `known` 数组中的 `'strain/breed'` → `'strain or breed'`。
- [ ] `wizard-state.service.ts`：`syncLegacyFieldsFromChoices`（L97-98）、`setStrainBreed`（L578-587）中的列名替换。
- [ ] `wizard-generator.service.ts`：`shouldEmit`/`hasCharacteristicOutputValue`/`createStrainBreedColumn`（L125-128、L386、L708-709）中的列名替换。
- [ ] `llm/prompt.service.ts` L156 示例列名替换。
- [ ] 全库 `grep -rn "strain/breed"` 确认无残留（编辑器历史文件解析除外，如有需保留兼容映射，见 Step 2b）。

### Step 3 — multiplex 的 assay name 按 run 共享（问题 #3）
- [ ] `wizard.ts`：`WizardExpansionRow` 增加 `runName?: string`。
- [ ] `buildWizardExpansionRows()` 构建每行时写入 `run.name`。
- [ ] `wizard-generator.service.ts` `createAssayNameColumn()`：改为 `runName` + 分数（`F#`）+ 技术重复（`R#`），**移除** `sourceName` 与 `label` 拼接。同一 run 所有通道共享同一 assay name。
- [ ] 确保 label-free 下每文件唯一（不同 run → 不同 runName；同 run 多文件由 F/R 区分）；multiplex 下唯一性由 `source name + assay name + comment[label]` 保证。

### Step 4 — 输出 `characteristics[pooled sample]`（问题 #5）
- [ ] `wizard.ts`：`WizardExpansionRow` 增加 `pooledSampleIndices?: number[]`，在 `buildWizardExpansionRows()` 中填充（pooled 通道取成员；sample/bridge/carrier 按角色标记）。
- [ ] `wizard-generator.service.ts` 新增 `createPooledSampleColumn()`：
  - sample → `not pooled`
  - pooled 且有成员 → `SN=<name1>;SN=<name2>`（复用 `resolveChannelSourceName` 的成员解析）
  - pooled 无成员 / bridge / carrier → `pooled`
- [ ] 当任意 run 存在 pooled/bridge/carrier 通道时输出该列；否则省略。列位置放在 `characteristics[biological replicate]` 之后（characteristics 区）。
- [ ] 与编辑器 `sdrf-config.ts` 的 `characteristics[pooled sample]` 语义一致。

### Step 5 — 数据文件元数据列顺序对齐规范（问题 #4）
- [ ] `wizard-generator.service.ts` `generate()` 中，将列顺序调整为规范 canonical 顺序（§8.1 + §5 最小示例）：
  `source name → characteristics[...] → assay name → technology type → comment[proteomics data acquisition method] → comment[label] → comment[instrument] → comment[cleavage agent details] → [推荐 comment 列] → comment[modification parameters] → comment[fraction identifier] → comment[technical replicate] → comment[data file] → comment[sdrf version] → comment[sdrf template] → comment[sdrf annotation tool] → factor value[...]`
- [ ] 保持「characteristics 在 assay name 之前、factor value 最后」不变。

### Step 6 — provenance 与小字段（问题 #6/#8/#9/#14）
- [ ] 新增 `comment[sdrf annotation tool]` 列，值为 `sdrfedit v0.1.0`（新增常量 `WIZARD_ANNOTATION_TOOL`，放在 `comment[sdrf version]` 之后）。
- [ ] `wizard.ts`：`WizardSampleEntry.sex` 类型与 quick picks 增加 `intersex`。
- [ ] age quick picks 增加 `pooled`。
- [ ] `sdrf-age-input.component.ts`：支持比较运算符 `>18Y`/`>=21Y`/`<65Y`（单值模式加一个运算符选择，输出前缀运算符）。
- [ ] `comment[cleavage agent details]` 兜底：区分「未选」（`not available`）与「不适用/未消化」（`not applicable`）——在 Step 5 加一个「No cleavage / 不适用」选项（复用 `COMMON_CLEAVAGE_AGENTS` 中已存在的 `No cleavage`）。

### Step 7 — 推荐列（问题 #10/#11，范围 D）
- [ ] **7a. 验证 characteristics 推荐列**：确认 Step 2 的 `recommendedColumns` 已含 `characteristics[cell type]`、`characteristics[ancestry category]`、`characteristics[individual]`、cell-lines / single-cell / immunopeptidomics / crosslinking 的 characteristics 推荐列；生成器在用户填值后正确输出。补漏：若 `getWizardCharacteristicColumns` 未返回某父模板推荐列，修正其解析。
- [ ] **7b. 新增 comment 推荐列采集**：
  - `template.service.ts` 新增 `getWizardCommentColumns(selection)`（仿照 `getWizardCharacteristicColumns`，但过滤 `comment[...]` 且 requirement=recommended，来自 technology + experiment 模板的合并解析）。
  - `wizard.ts`：`WizardState` 增加 `dynamicCommentDefaults: DynamicColumnDefault[]`。
  - `wizard-state.service.ts`：新增 `setCommentDefault/getCommentDefault/removeCommentDefault`（仿照 `setColumnDefault` 系列）。
  - `instrument-protocol.component.ts`：新增「Recommended technical metadata」区，动态渲染这些 comment 列（可选输入 + ontology/UNIMOD 搜索提示，复用 OLS/unimod 服务）。
  - `wizard-generator.service.ts`：新增 `createDynamicCommentColumn()`，在 Step 5 的推荐 comment 列位置输出（用户填值才输出，未填跳过）。
- [ ] **7c. DIA 特殊处理**：`comment[scan window lower/upper limit]`、`comment[isolation window width]` 走 7b 通用机制；无需专属 UI（数值输入即可，模板 validator 提供格式提示）。

## Verification

- [ ] `npm run build` 通过（TypeScript 编译无误）。
- [ ] `npm run start` 手动走通向导：
  - **label-free（human + ms-proteomics）**：检查 `comment[sdrf version]` = `v1.1.0` 且与 `comment[sdrf template]` 版本一致；列顺序符合 Step 5 定义；`comment[sdrf annotation tool]` = `sdrfedit v0.1.0`。
  - **TMT multiplex**：同一 run 所有通道 `assay name` 相同，`source name + assay name + comment[label]` 唯一；pool/bridge/carrier 行有 `characteristics[pooled sample]`，值符合 `not pooled`/`pooled`/`SN=...;SN=...`。
  - **vertebrates / plants**：Step 2/3 的 strain 字段渲染为 `characteristics[strain or breed]` 并正确保存。
  - **human**：sex 出现 `intersex`；age 支持 `>18Y` 等比较符与 `pooled`。
  - **DIA**：Step 5 出现 scan window 三个推荐列，填值后生成器输出对应 `comment[...]` 列。
  - **cell-lines / single-cell**：Step 2 出现其 characteristics 推荐列（cell type、passage number 等），Step 5 出现其 comment 推荐列。
- [ ] 用 `sdrf-pipelines` 校验生成的 TSV（`parse_sdrf validate-sdrf --sdrf_file x.sdrf.tsv`），确认无 error；warning 逐条评估是否预期。
- [ ] 回归：确认 `column_order` 校验（characteristics 在 assay 前、technology type 紧跟 assay、factor value 最后）不报错。
