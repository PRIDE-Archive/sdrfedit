# 动态 SDRF 模板目录与规则引擎设计

状态：已实现目录同步、规则解析、动态页面、列生成及快照预检查（2026-09-24）。实际接口、验证覆盖范围和部署说明见 `docs/template-selection-rules.md`；专用值验证与 ontology 校验仍明确提示需进一步验证。以下保留设计依据。

## 目标与边界

每次打开模板选择页检查 bigbio/sdrf-templates/main 的更新。新增模板、已有规则类型的变更、版本更新与层级调整，不再需要修改模板 ID 列表或业务分支。一次向导使用完整、一致且可追踪的仓库快照。未知规则语义不静默忽略，不能承诺自动理解任意未来 schema。

数据来源：
- https://github.com/bigbio/sdrf-templates
- https://github.com/bigbio/sdrf-templates/blob/main/templates.yaml
- https://github.com/bigbio/sdrf-templates/blob/main/sdrf-template.schema.json
- https://github.com/bigbio/sdrf-templates/blob/main/scripts/generate_manifest.py

已核实的重要差异：manifest 生成脚本读取 exclusive_with，当前模板与 schema 声明 mutually_exclusive_with；完整关系必须读取各版本 YAML。当前 schema 有 excludes.templates / categories / columns，extends 支持精确版本、下界和上下界范围；requires 当前 schema 定义的是 layer。

## 1. 仓库同步与原子快照

建议在现有后端建立 TemplateCatalog 服务，AI 工具和浏览器使用同一个目录。

进入第一页 → revalidate main 的 commit SHA → 未变化则复用完整缓存；变化则从固定 SHA 获取 manifest、schema、模板 YAML 及所需依赖版本 → 验证与编译 → 原子替换 latest 指针。

不得混用多个 main 请求期间产生的不同提交。manifest 是发布目录，不将任意尚未进入 manifest 的文件直接展示为模板。并发进入页面合并相同同步任务；条件请求和服务端缓存减少下载。进入页面必须发起新鲜度检查，不能只被固定的前端五分钟 TTL 短路。

CatalogSnapshot 包含 snapshotId、repository、commitSha、checkedAt、fetchedAt、manifestSchemaVersion、templateSchemaHash、parserVersion、templates（name@version）、依赖闭包、规则来源和诊断。缓存键包含 SHA 和解析器版本。

任一必需文件缺失、版本无法满足、循环继承或关键规则格式不兼容时，不发布半成品目录。首次同步失败显示错误与重试；已有完整缓存时标明旧快照及日期，不声称是最新，不回退到手写简化模板。

## 2. 解析与兼容性

保留原始 YAML 与未转换的规则参数；标准化名称但不丢弃未知参数。单个版本 YAML 是该版本语义来源，manifest 用于发现版本、路径和校验；缺失字段与显式 null/false/空数组分开处理，不使用 || 合并布尔值。有效默认值按经支持的 schema 解释。

分别校验上游 schema 和本地能力清单。JSON Schema 只能校验结构，不能替代规则执行。新描述、展示字段可保留；新选择约束、新合并语义或不支持的关键 validator 必须产生兼容性诊断，不能以“支持所有新模板”为名默默放行。

## 3. 版本与依赖图

节点键 name@version，extends 是带版本范围的边。使用 manifest.versions 查找满足范围的版本；预发布版本采用明确的 prerelease 策略。不得截掉 @ 后统一选择 latest。

组合涉及同名父模板时计算约束交集并形成版本锁；无法共同满足则返回版本冲突，不混合两个不兼容版本的同名定义。

解析依赖闭包、循环检查、缺失引用、继承链与叶节点。保存 sourcePath、字段路径和引入该规则的父模板，使错误可解释。上游未明确的父级互斥传递与 validator 合并语义，核对官方实现并固定契约测试，避免自行猜测。

## 4. 通用规则与列组合

规则不出现具体模板名称的 if 分支：
- layer：按仓库分类，不根据名称推断。
- extends：解析祖先闭包与匹配的技术依赖。
- mutually_exclusive_with：任意一方声明即冲突；按核实的继承语义执行祖先约束。
- requires：按已支持 schema 解释层级依赖，不凭缺失字段创造约束。
- usable_alone：检查单独使用条件，与继承技术依赖和组合要求共同处理。
- excludes.templates/categories/columns：列组合操作，不等价于模板互斥。

每个列贡献记录 originTemplate、originVersion、selectedRoot 和完整定义路径。在各选择根的贡献上应用排除与自保规则，再按官方合并语义生成 effectiveColumns。不能先全局去重再丢失列来源。缺省 requirement/validator 参数不应覆盖显式父级定义。

Columns 预览、后续字段表单、生成器、导出声明与校验都使用同一 snapshotId 和已解析的选择结果。未知字段使用类型/ontology/enum 驱动的通用控件。保留专用控件作为渲染插件，不能决定模板是否被支持。

## 5. 页面状态与交互

选择状态使用 selectedTemplates: [{ name, version }] 和 snapshotId。layer、继承、分组和附加属性均从快照派生，逐步移除 sampleTemplate / sampleMetadataTemplates / experimentTemplates 作为并行事实来源；旧草稿通过单次迁移转换。

页面主分组根据 layer 动态生成；layer=null 为内部模板，不作为普通选项。未知层不能猜测选择规则，应显示兼容性信息。名称、描述采用仓库数据，缺少展示名则格式化 ID；图标只是可选展示配置。稳定性由版本/明确状态判断，移除“名称含 metabolomics 就是 development”的逻辑。

官方 schema 没有 organism / clinical / environment 子分组。此前四物种区域不能从互斥图可靠推导（Metaproteomics 也与它们互斥）。推荐以官方层级为主；若保留物种展示区，其配置必须明确为 presentation-only，新模板默认回到所属 layer，配置不得参与合法性判断。

选中模板后即时计算每张卡片状态：selected、available、conflicting、missing-dependency、already-inherited、unsupported。冲突卡片显示具体原因；缺依赖允许暂存选择但禁用 Next，给出需要补选的层。不要静默删除用户选择或任意代选依赖。

重新进入第一页检查上游；有变化时展示新增/删除/版本/规则差异，重新校验当前选择。后续步骤继续锁定本次快照，避免填写过程中后台更新规则。导出前用相同快照验证。

## 6. 规范正文与仓库 YAML 的边界

当前 LC-MS / GC-MS 互斥只在规范正文出现，YAML 未声明。Technology 必选及层级选择基数也不由每个模板的 layer 字段完整表达。

将这类通用规范政策与仓库规则分开，标注来源和版本。用户要求“严格跟仓库一致”时不保留模板 ID 特判。应推动上游补齐机器可读字段；在此之前展示规范差异提示，不宣称纯 YAML 引擎已完整覆盖正文。

不在浏览器运行时用自然语言或 LLM 猜测 README 的规则。若产品要求两者都强制符合，额外规范政策必须是单独可审计、可更新的机器可读来源。

## 7. 服务接口建议

POST /api/template-catalog/revalidate
GET /api/template-catalog/snapshots/{snapshotId}
POST /api/template-catalog/resolve  { snapshotId, selectedTemplates }

resolve 返回 resolvedTemplates、effectiveColumns、leafTemplates、conflicts、unmetRequirements、perTemplateAvailability、diagnostics 以及各规则出处。

后端负责权威解析和导出前校验，前端可使用后端编译的冲突/依赖索引即时反馈。AI 模板查询替换独立 GitHub 缓存和旧“零或一个 sample”固定提示，读取同一目录和选择结果。

## 8. 迁移与验收

1. 建立快照同步、原始解析、版本锁与完整性检查。
2. 建立不依赖具体模板 ID 的规则与列组合内核。
3. 页面切换到目录驱动的分组及 selectedTemplates，迁移草稿。
4. 后续步骤、生成器、Review、AI 和 validator 统一快照。
5. 删除手写 fallback、固定物种列表、LC/GC 特判、固定开发模板判定和后端重复模板解释。

必须以未知名称的合成模板验证：新增模板无需改代码即可显示；互斥增加/删除实时变化；单向声明互斥成立；已知名称没有 YAML 约束时不残留特判；新增父模板自动展开；版本范围不能错误选择 latest；三类 excludes 保持来源及自保；变更 layer 后 UI 自动移动；显式 false 保留；新旧 commit 不混用；部分网络失败不发布部分目录；旧草稿恢复并显示新规则冲突；未知选择语义明确不支持；预览/生成/AI/验证使用同一快照。
