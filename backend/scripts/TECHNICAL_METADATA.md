# 独立技术元数据提取工具

此 CLI 仅读取文件并输出 JSON 证据，不修改 SDRF。
AI 助手现已通过 `pride_technical.py` 适配层接入两个受限工具：
`list_pride_technical_files` 和 `extract_pride_technical_metadata`。
CLI 的任意本地路径/URL 能力不向 AI 暴露。
使用后端现有的 `httpx`、`lxml`，没有新增依赖。

## 使用

在项目的 `backend` 目录运行：

```bash
.venv/bin/python scripts/extract_technical_metadata.py /path/to/result.mztab.gz --output /tmp/evidence.json
.venv/bin/python scripts/extract_technical_metadata.py /path/to/result.mzid --timeout 15 --max-download-mib 8 --max-decoded-mib 32
.venv/bin/python scripts/extract_technical_metadata.py /path/to/mqpar.xml
```

也支持显式指定 HTTP(S) URL。文件名不能识别时，使用 `--format mztab|mzidentml|mqpar`。
所有格式均支持以 `.gz` 结尾的 gzip 文件。只支持单个 gzip member；未提前完成时，拼接 member 或尾随压缩数据报错。

退出码：`0` 元数据提取完成；`2` 达到预算或只读到不完整元数据；`1` 读取/解析错误。
参数错误遵循 argparse 的退出码 `2`，不输出提取结果 JSON。

## 支持范围

| 格式 | 提取信息 | 停止条件 |
| --- | --- | --- |
| mzTab | 修饰原始 CV/位点字段、仪器、软件、运行/样本/assay 关联、描述和源文件注释 | 读到第一个结果表头 |
| mzIdentML | 搜索协议及软件引用、搜索修饰、酶、漏切、带单位和正负方向的容差、软件、数据库及谱图输入关联 | 协议与 Inputs 之后的 AnalysisData 开始处 |
| mqpar.xml | 原始文件列表、参数组索引、按组修饰/酶/容差、软件版本、MS/MS 参数预设 | XML 文档结束 |

XML 跳过的序列节点会及时释放，避免保存整棵结果树。但是 mzIdentML 的 SequenceCollection 可以位于协议之前：
需要读取和扫描这段内容，不能保证所有 mzIdentML 都能快速获取完整技术参数。

CLI 核心暂不支持 mzML、厂商 RAW、旧 PRIDE XML、ZIP/TAR，不做多个文件间自动合并。
AI 适配层增加了 PRIDE 文件发现和会话缓存。
第一版输出可回查的事实，尚未进行完整 CV 映射、SDRF 字段转换和自由文本参数提取。

## 证据语义

- 每条 fact 包含源文件、原始字段/值、行号或 XML 位置、分析协议/参数组 scope。
- `missing_fields_mean: unknown`：缺失字段不是“没有该参数”。显式空列表与字段缺失分开表示。
- 描述、标题和 COM 注释标记为 `text`。不会从标题中的 CID/ETD 推导 ETciD，也不会用文件数推断生物重复。
- mzIdentML 保留 `fixedMod` 原值、单位、正负容差、软件和输入引用，不跨协议混合参数。
- 同协议同 accession 同时声明固定/可变修饰时，保留双方并提示核对位点/协议，不自动裁决。
- MaxQuant 的 MS/MS 预设分别保留 Name 和单位标志。某个预设存在不代表它实际用于全部输入文件。
- mzTab 的来源转换警告保留在 `warnings`。PXD000070 的 COM 说明从旧 PRIDE XML 转换只能报告可变修饰；不能丢掉这条限制后仅凭 `No fixed modifications searched` 作绝对判断。

`status: complete` 仅表示当前支持的元数据区域读取完成。不是完整文件校验，不代表每个技术字段都有报告；
提前停止不会校验未读结果区、XML 尾部或 gzip 尾部校验和。头部完整但没有遇到 mzTab 结果表头时返回 `partial`。

## 资源预算

默认总耗时 15 秒、源数据读取预算 8 MiB、解压后读取上限 32 MiB、最多 2000 条事实、单行最多 256 KiB。
读取以 16 KiB 为块；源数据预算在块边界检查，实际收到的字节数最多超过预算一块，超过预算的块不进入解析。
解压输出按块限制，不会先把完整 gzip 解压到内存。超时和限额返回已获得的证据，并标记具体停止原因。

HTTP 使用流式读取，提取完成立即关闭连接。`source_bytes_read` 统计交给工具的响应体字节，
不是底层 socket/TLS 或操作系统预读的精确流量。服务端忽略 `Accept-Encoding: identity` 时明确报错，避免混淆压缩层级和计数。
`elapsed_seconds` 包含本次请求建立、下载和解析，不能直接当纯解析 CPU 时间。

XML 禁用外部实体/网络加载，拒绝 DTD。CLI 允许操作者指定本地路径和 HTTP(S) URL。
AI 仅能提交当前会话中发现的 PRIDE 文件 ID：适配层限定官方归档主机及对应 PXD 路径，
将官方 FTP 地址转换为 HTTPS，拒绝跳转、任意外部 URL 和本地路径。

## AI 调用规则

- 优先复用论文、项目元数据、用户证据与缓存。证据已充分则跳过，不是每个向导步骤都调用。
- Instrument & Protocol 缺少技术证据或相关来源冲突时调用；字段已填入默认值不代表有证据。
- 用户明确要求核对时可以调用；Runs & Files 的分析/文件关联不清时也可以调用。
- 不用来推断生物重复、组织、疾病、混池或独立样本数量。
- 优先相关的 mqpar.xml、mzTab；只有轻量来源不足时才尝试 mzIdentML。
- 调用时机通过系统提示、步骤流程和工具说明指导模型。文件访问范围、缓存、分页、
  单文件预算及文件数量限制由后端执行。
- 每项目/会话缓存最多尝试 3 个不同文件；重复读取、翻页及失败/超时均复用缓存。
  会话 TTL 到期或该会话保留超过 4 个项目时旧缓存可能被清除；旧 ID 需重新发现。
- 提取最多保留约 500,000 JSON 字符的事实，每次返回最多 20 条且受输出长度限制。
  必须按 nextOffset 翻页；超长值、源警告和存储截断均明确标记，不可据此断言完整参数集。
- 可选工具失败/预算用尽本身不阻断自动注释。必需的实验信息确实不足或冲突妨碍正确注释时，
  才可能需要用户补充；缺失的可选容差保持未填。
- 提取事实不自动成为已验证 ontology，也不直接改向导；仍由现有校验和建议卡片流程处理。

## 重现测试

```bash
.venv/bin/python -m pytest tests/test_technical_metadata.py tests/test_pride.py -q
.venv/bin/python scripts/benchmark_technical_metadata.py --live --output-dir /tmp/technical-metadata-check
```

不加 `--live` 时只执行两个本地合成大文件尾部测试。合成尾部用于验证提前停止，不是完整、有效的质谱结果文件。
公开文件分别来自 PRIDE、HUPO-PSI 官方 mzIdentML 示例和 Galaxy-P 的 MaxQuant 测试文件。
脚本校验已核对的具体修饰、容差和单位，输出逐文件证据和 `summary.json`；任一校验失败返回非零退出码。
公开分支内容可能更新，来源 URL 保存在每份结果中；MaxQuant 示例固定到 Git commit。

## 格式参考

- SDRF 实验参数的来源应保留；本工具不把提取结果自动作为最终注释。
- mzIdentML：https://hupo-psi.github.io/mzIdentML/mzidentml.html
- mzTab：https://github.com/HUPO-PSI/mzTab
- MaxQuant 示例：https://github.com/galaxyproteomics/tools-galaxyp/blob/ab4e4f1817080cbe8a031a82cb180610ff140847/tools/maxquant/test-data/single/mqpar.xml
