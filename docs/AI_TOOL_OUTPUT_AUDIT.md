# AI 助手工具返回结果审计与整改清单

审计日期：2026-09-25。状态：T01 已修复并完成回归验证，其余项目待处理。

本文件基于审计时的工作区代码，包括当时尚未提交的修改。后续实现变化后，应重新核对对应结论。范围为 SDRF 向导助手的 21 个注册工具，以及独立处理的 `propose_wizard_actions`；不代表已逐个验证线上服务的实时返回。

## 目标与结论

检查工具返回是否精简、是否包含无关或重复内容、是否存在过量输出，以及截断是否造成证据丢失。整改应保证：任何不完整结果都明确说明省略内容、是否可恢复和续读方式；缺失数据不能被误读为源数据不存在。

目前工具大多已筛选上游字段，文献也采用“文档 ID + 按需读取”的结构，但截断、分页和大小控制尚不统一。主要风险是协议和规范片段静默截断、文件列表超限后整体丢失，以及部分结果虽标记不完整却不能继续读取。

## 验证记录

本次没有修改业务代码，没有批量调用外部服务。通过内存中的构造数据与依赖替换验证了以下行为：

| 场景 | 验证结果 |
| --- | --- |
| PRIDE 描述和协议超过 2,500 字符，样本属性为 45 个 | 尾部证据消失，属性只返回 40 个，无截断标志 |
| 400 个构造的 RAW 文件名及 PRIDE URL | handler 输出 104,122 字符，dispatcher 将整个结果替换为超限错误 |
| 规范片段在第 1,600 字符后包含约束 | 约束不在返回结果中，无截断标志或续读入口 |
| 文档章节名为 `TableS1.csv / tables` | 按返回的原名请求，读取器转小写后报告章节不存在 |
| XLSX 单元格含没有缓存结果的 `=1+1` 公式 | 解析为无警告的空字符串 |

当前本地 `backend/data/spec_index/chunks.json` 共 98 个片段，其中 32 个超过 1,600 字符，最长 28,791 字符。这些是本地索引快照数据，不代表线上索引。

以下现有测试通过，共 105 项。通过不代表已覆盖上面的边界条件；本次复现脚本未加入正式回归测试。

```bash
cd backend
.venv/bin/python -m pytest -q \
  tests/test_pride.py \
  tests/test_supplements.py \
  tests/test_document_listing.py \
  tests/test_pride_technical.py \
  tests/test_chunker.py \
  tests/test_literature_acquisition.py
```

## 优先级与进度

P1：优先处理，直接影响证据完整性或完整列表获取。P2：后续处理，影响特定输入、来源判断或上下文效率。设计项：限制本身未必错误，需要明确产品需求与恢复策略。

所有复选框表示“修复并完成验收”，而不是“已审计”。

- [x] T01 / P1：PRIDE 元数据静默截断（2026-09-25）。
- [x] T02 / P1：RAW 文件列表过大且无法分页（按用户要求改为完整返回和缓存，2026-09-25）。
- [ ] T03 / P1：规范检索片段静默截断。
- [ ] T04 / P2：附件候选列表截断后不可续读。
- [ ] T05 / P2：文档章节大小写导致读取失败。
- [ ] T06 / P2：Excel 公式缓存缺失被当成空白。
- [ ] T07 / P2：文档列表缺少证据类型。
- [ ] T08 / P2：模型可见结果中的冗余和内部字段。
- [ ] T09 / P2：普通工具超限处理缺少可恢复结果。
- [ ] T10 / 设计项：技术证据预算与超长事实的恢复路径。
- [ ] T11 / P2：跨轮证据摘要截断和覆盖。
- [ ] T12 / 设计项：其他列表、搜索和操作反馈的预算规范。

## T01：PRIDE 元数据静默截断

状态：已解决（2026-09-25）。以下“现状”描述审计时的旧行为。

位置：[pride.py](../backend/app/tools/pride.py)，`fetch_project()`。

现状：`description`、`sampleProcessingProtocol`、`dataProcessingProtocol` 各取前 2,500 字符；`sampleAttributes` 取前 40 个。没有字段级截断标志、原始长度、总数或后续读取接口。

影响：方法后半段的酶、标记、分级、软件参数等证据可能消失，模型无法区分“未返回”和“源数据未提供”。已通过构造数据复现。

建议：完整长文本保存为会话文档，返回预览、原始长度和可读 ID；属性采用分页。保留来源与字段身份。

验收：尾部证据可通过工具取得；返回明确标识预览；超过 40 个属性可以全部遍历；源字段为空与字段未完整返回可区分。

实际实施：按用户要求直接返回完整内容，不采用本项最初建议的预览或分页方案。移除三个文本字段的 2,500 字符截断及样本属性的 40 条截断；为 `get_pride_metadata` 配置 `max_result_chars=None`，防止完整元数据被 dispatcher 的 24,000 字符兜底整体替换为错误。其他工具仍沿用默认上限。

保留现有字段映射、HTML 清理和空白规范化；“完整”指当前元数据工具所输出字段不再按长度或数量裁剪，并非将 PRIDE 原始 HTTP JSON 的所有未映射字段新增到输出。后续修复已将项目元数据按 session/accession 完整缓存，并在后续请求中直接注入完整 JSON，取消该工具的跨轮摘要。界面 8,000 字符预览和本地历史 4,000 字符预览不影响完整缓存的模型上下文。缓存沿用 session TTL，非永久存储。

回归验证：`tests/test_pride.py` 新增超 24,000 字符元数据、85 个混合分组属性、空字段及其他工具上限保持的测试。以下测试共 64 项通过：

```bash
cd backend
.venv/bin/python -m pytest -q tests/test_pride.py tests/test_publication_agent.py tests/test_setup_gate.py tests/test_progress_updates.py
```

## T02：RAW 文件列表过大且无法分页

已修复：按用户要求取消 `limit` 和 400 文件截断，为 `get_pride_raw_files` 豁免 dispatcher 输出长度限制；完整文件名和可用 URL 按 session/accession 缓存并跨轮直接重放，不再生成 RAW 摘要。相同项目的重复/并发调用复用缓存；失败可重试，缓存沿用 session TTL。每轮从当前项目缓存恢复 `verified_file_urls`，无需再次获取即可补充导入操作的 URL。保留现有 RAW 分类规则及名称去重，不下载 RAW 文件内容。前端独立导入入口仍直接请求 PRIDE。

回归验证：850 个 RAW 文件加 1 个 SEARCH 文件，工具返回超过 24,000 字符仍完整；第二轮完整重放并为末尾文件补充 URL，上游仅请求一次。旧调用额外携带 `limit` 时仍返回完整列表，避免污染缓存。该方案替代下述最初的分页建议；模型输入大小随项目文件数量增长。

位置：[pride.py](../backend/app/tools/pride.py)，`fetch_raw_files()`；[registry.py](../backend/app/tools/registry.py)，工具声明与 `dispatch()`。

原状：默认 `limit=400`，文件名同时出现在 `rawFileNames` 和 `fileUrls` 的 key 中，URL 再次包含文件名。超过 24,000 字符时，普通工具 dispatcher 丢弃整个结果并返回错误。只有 `limit`，没有 `offset`；减小 limit 只能取得前缀，增大则可能再次超限。

影响：大型项目无法可靠取得完整文件列表，连已计算出的总数也可能被错误替换掉。构造的 400 文件结果为 104,122 字符，已复现整体替换。

建议：`files: [{name, url}]` 结构，按条数和序列化大小分页，提供总数和 `nextOffset`。稳定排序；完整遍历无需反复下载或重复返回前面的文件。

验收：大列表可无遗漏、无重复遍历；每页在预算内；总数保留；参数边界校验；调整 agent 中文件 URL 收集及相关调用方的兼容逻辑。

## T03：规范检索片段静默截断

位置：[spec_search.py](../backend/app/tools/spec_search.py)，`search_specification()`；[chunker.py](../backend/app/rag/chunker.py)，`_split_long()`。

现状：搜索结果 `text[:1600]`，没有 `chunkId` 续读机制。分块目标是 2,400 字符，但单个超长段落不会继续拆分。本地索引已有 32/98 个片段超过输出上限，最长片段只返回约 5.6% 的内容。

影响：规则的例外、限制、允许值可能位于被丢弃的后半段。已构造尾部约束并复现丢失。

建议：合理拆分超长段落；搜索结果提供片段 ID、原始长度、预览标志；增加完整片段读取或分页读取能力。切分时保留表格、列表及段落的解释关系。

验收：长段落和长表格中的尾部规则可检索或续读；不会把预览表示为完整规范；来源与章节引用保持稳定。调整分块后验证索引重建。

## T04：附件候选列表截断后不可续读

位置：[supplements.py](../backend/app/tools/supplements.py)，`discover()`、`discover_pride()`；[registry.py](../backend/app/tools/registry.py)，`_find_supplements()`。

现状：两路发现各取前 40 个并标记 `truncated`，但没有分页。PRIDE 分支将多种 TXT/CSV/TSV/PDF 等文件列为候选，筛选较宽。合并结果最多可达 80 个候选，存在超过普通结果预算的风险。

影响：普通结果文件可能挤占样本设计表的位置；后续候选不可达。超限风险由代码路径推断，未在本次对真实大项目逐项测量。

建议：缓存候选、去重、按相关性排序并分页；保留来源、原始候选总数和各来源的发现状态。

验收：第 40 个之后的候选可读取；混合来源无重复；发现失败与不存在可区分；页面大小受控。

## T05：文档章节大小写导致读取失败

位置：[registry.py](../backend/app/tools/registry.py)，`_read_document()`；[supplements.py](../backend/app/tools/supplements.py)，`parse_uploaded_attachment()`。

现状：读取时对章节名 `strip().lower()`，但上传 ZIP 的章节 key 包含保留大小写的文件名。原样传回 `TableS1.csv / tables` 会被改写成另一个不存在的 key。

影响：模型按工具返回的章节名或 `nextReads` 读取仍失败，尤其影响单章节后续分页。已复现。

建议：原名精确匹配优先；大小写兼容匹配必须无歧义；始终返回实际章节 key。

验收：大小写混合、Unicode 和带路径文件名可原样读取；大小写冲突不会选错；后续分页可完成。

## T06：Excel 公式缓存缺失被当成空白

位置：[supplements.py](../backend/app/tools/supplements.py)，`parse_attachment()`、`table_text()`。

现状：XLSX 使用 `data_only=True`，不计算公式。缺少缓存结果的公式单元格变为 `None`，再转成空字符串。构造 `=1+1` 且没有缓存值的工作簿已复现。

影响：公式值不可用与源单元格为空无法区分，可能丢失样本分组、重复编号等信息。

建议：检测公式及其缓存状态；缺缓存时保留坐标、公式和警告，不擅自计算或猜测。另行评估合并单元格关系；当前纯值序列化未显式保留该结构，此项尚未做专项复现。

验收：空白、缓存值、缺缓存公式三者可区分；结构警告可通过文档描述或读取结果传给模型。

## T07：文档列表缺少证据类型

位置：[registry.py](../backend/app/tools/registry.py)，`_list_documents()`、`_find_publication()`。

现状：文档列表没有 `evidenceKind`，但复用文档的提示要求模型据此区分全文、摘要和附件。部分标识符只读取 metadata 顶层，也应核对嵌套 identifiers 的一致性。

建议：统一文档描述结构，显式提供 `article / abstract / supplement` 等类型、来源和规范化标识符；未知类型明确表示未知。

验收：新获取、列表恢复及 `sessionDocuments` 中的证据类型一致；摘要或附件不会被描述为文章全文。

## T08：模型可见结果中的冗余和内部字段

这组主要是上下文效率改进，不等于所列字段全部无用。

| 位置 | 现状 | 建议 |
| --- | --- | --- |
| `registry._document_result()` | `readingStatus`、`availableSections`、`nextReads` 重复章节信息；完整 metadata 含 `rawPath`、SHA256 等 | 模型字段白名单；统一章节描述；内部调试信息留在日志 |
| 多个工具的 `nextStep/guidance/note` | 每次重复固定的长规则 | 固定行为放工具说明，动态结果保留本次特有反馈 |
| `technical_metadata.Evidence.add()` | 每个事实重复 source；部分 value 与 raw 相同 | 来源可置顶；有必要时才保留两个值 |
| `literature.parse_jats()` | 表格整段 text 与逐行形式重复正文 | 保留标题、脚注和一次结构化行内容 |
| `http.py` 与解析异常 | 部分错误带上游响应前缀，可能含 HTML | 结构化错误码、简洁消息、重试提示；诊断原文与模型输出分离 |

验收：以代表性结果比较序列化长度；来源、证据范围、缺失含义、错误原因及续读信息不能因精简而丢失。

## T09：普通工具超限处理缺少可恢复结果

位置：[registry.py](../backend/app/tools/registry.py)，`dispatch()`。

现状：普通结果 JSON 默认超过 24,000 字符后整体替换为错误，只有原始字符数和泛化的“减少内容”提示。不是保留前 24,000 字符。部分工具没有可减少内容的参数，提示无法执行。T01 修复后 `get_pride_metadata` 已单独豁免，其他工具仍待处理。

建议：各 handler 在输出前控制自身分页预算；dispatcher 保留最后防线，并返回有针对性的恢复参数或可读取结果引用，避免通用裸截断 JSON。

验收：支持分页的工具正常情况下不会触发兜底；不可分页的超限也有明确恢复途径；有效总数、来源与结果身份尽量保留。

注意区分三个边界：模型侧普通工具结果 24,000 字符；界面结果预览 8,000 字符；localStorage 结果预览 4,000 字符。后两者的截断不能当成模型实际拿到的原始内容。

## T10：技术证据预算与超长事实的恢复路径

位置：[pride_technical.py](../backend/app/tools/pride_technical.py)、[technical_metadata.py](../backend/app/tools/technical_metadata.py)。

已有较好的不完整性表达：`catalogueTruncated`、`storedFactsTruncated`、`warningsTruncated`、`valueTruncated`、`status`、`stopReason`、`coverage`、`nextOffset`。

仍需明确的限制：

- 候选目录最多缓存 200 个；普通分页只能读这部分。
- 每项目/会话最多尝试 3 个不同文件。
- 单个事实序列化超过 10,000 字符时返回预览，无完整事实读取接口。
- 警告最多 12 条，每条 500 字符；有截断标志，但无完整警告读取接口。
- 证据缓存约 500,000 字符预算；超过后部分事实不再保存。
- 提取默认限制包括 15 秒、8 MiB 下载量、32 MiB 解压后数据量、2,000 个事实和 256 KiB 单行。
- `offset` 遍历的是已缓存事实，不代表从源文件断点继续提取。

建议：先决定是否支持按需扩大预算、完整事实读取或定向重提取；不要简单去掉资源保护。把不可恢复截断与可分页预览在结构上分开。

验收：模型可区分“缓存已读完”和“源文件已完整覆盖”；截断值不能支持确定性标注；任何扩展读取有明确资源上限。

## T11：跨轮证据摘要截断和覆盖

PRIDE 项目元数据部分已修复（2026-09-25）：不再生成 `_evidence_note`，改为完整结果缓存及跨轮直接重放；相同 session/accession 的重复与并发调用复用同一次获取，失败不缓存，过期允许重新获取。回归测试 `test_pride_context.py` 验证超长正文、85 个样本属性、多项修饰和文献完整重放，以及隔离、并发去重、失败恢复和过期。下述摘要限制仍适用于其他工具，故 T11 整体保持未完成。

位置：[session.py](../backend/app/session.py)，`add_evidence()`；[agent.py](../backend/app/llm/agent.py)，`_evidence_note()`。

现状：每条摘要取前 1,200 字符，最多 12 条；文档摘录最多 700 字符；同一文档 key 的后续摘要覆盖先前摘要。摘要为代码模板，不是模型的语义总结，也不是所有工具都有摘要。

影响：完整文档可能仍可重读，但已读各页的关键发现并未累积；摘要自身也可能被切断且无标志。缓存默认 2 小时，进程重启会丢失。

建议：结构化记录事实、来源和定位；按文档/章节合并关键发现；明确摘要不完整或已过期。避免将摘要当成完整证据。

验收：跨轮保留不同页的必要结论及出处；能区分记忆缺失与源数据缺失；过期后可重新获取公开证据。

## T12：其他工具预算和边界待统一

- `list_documents`：文档与章节列表无分页；大量文档时可能触发通用超限。
- `get_publication_supplement`：ZIP 成员列表最多允许 300 个成员，但列表本身无分页，长文件名可能使结果超限。
- `list_sdrf_templates`：可按 layer 筛选，但无分页或自身大小预算。
- `get_template_columns`：已有约 22,000 字符页预算，方向合理；单个超大列定义会报错，没有进一步拆读入口。
- `search_ontology` / `verify_ontology_term`：多条 description 只取第一条，无省略标志；单条描述长度没有独立预算。
- `search_cell_line` / `verify_cellosaurus_accession`：返回完整记录及同义词；可评估搜索摘要和详情分离，不能丢掉标注需要的属性。
- `search_specification`：还需统一 k 等数量参数的服务端边界校验。
- `check_pdf_url`：结果很小，但实际下载并缓存 PDF，不是 HEAD 检查；工具描述应反映成本，避免不必要的先检查再解析。
- `propose_wizard_actions`：独立路径，不经过普通工具 24,000 字符限制；拒绝和延后反馈也应有合理预算。自动模式下的“用户审核”固定反馈措辞应另行核对。

以上部分为代码审阅发现的潜在增长路径或设计改进，未全部使用极端输入复现。应以真实代表性数据测量后确定是否拆分工具。

## 全部工具覆盖表

| 工具 | 主要结论 / 跟踪项 |
| --- | --- |
| `get_pride_metadata` | T01、T09 |
| `get_pride_raw_files` | T02、T09 |
| `list_pride_technical_files` | 已有分页和截断标志；T10 |
| `extract_pride_technical_metadata` | 已有状态、预算和事实分页；T08、T10 |
| `find_publication` | 已筛选字段；T07、T08 |
| `get_publication_abstract` | 返回可读文档 ID，方向合理 |
| `find_publication_supplements` | T04、T09 |
| `get_publication_supplement` | T06、T08、T12 |
| `get_publication_full_text` | 工具存储 `allSections`，不受内部旧 `sections` 预览截断影响；T08 |
| `check_pdf_url` | 输出精简，下载成本见 T12 |
| `parse_pdf_url` | 返回文档描述，方向合理；T08 |
| `list_documents` | T07、T12 |
| `read_document` | 已按预算分页并返回实际偏移量；T05 |
| `search_specification` | T03、T12 |
| `search_ontology` | 数量有限、字段筛选；T12 |
| `verify_ontology_term` | 输出相对精简；T12 |
| `search_cell_line` | 数量有限、全记录输出；T12 |
| `verify_cellosaurus_accession` | 全记录可支持标注；T12 |
| `list_sdrf_templates` | T12 |
| `get_template_columns` | 已按条数及序列化大小分页；T12 |
| `validate_template_combination` | 已筛选字段，未发现同类静默正文截断 |
| `propose_wizard_actions` | 独立校验与反馈路径；T12 |

## 建议实施顺序

1. T01、T02、T03：先保障关键证据和完整文件列表可获取。
2. T05、T06、T07：修复读取失败、静默空值及证据类型不明确。
3. T04、T09：统一候选分页和超限恢复。
4. T08、T12：在不减少必要信息的前提下降低输出量。
5. T10、T11：完善较大任务的证据读取预算与跨轮记忆。

每项修复应在本文件更新状态，记录实现位置、针对性回归测试与仍存在的限制。设计建议不表示已经决定变更工具接口；接口变化需同步 agent、工具说明、测试及相关前端消费者。
