# dsh-benchmark

[![CI](https://github.com/dongsheng123132/dsh-benchmark/actions/workflows/check.yml/badge.svg)](https://github.com/dongsheng123132/dsh-benchmark/actions/workflows/check.yml)
[![MIT 许可证](https://img.shields.io/github/license/dongsheng123132/dsh-benchmark)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/Node.js-%E2%89%A522-339933?logo=nodedotjs&logoColor=white)](package.json)
[![Awesome DSH Plugins](https://img.shields.io/badge/Awesome_DSH-%E5%B7%B2%E9%AA%8C%E8%AF%81%E5%AE%9E%E9%AA%8C-0969da)](https://github.com/dongsheng123132/awesome-dsh-plugins/blob/main/README.zh-CN.md#2origin-%E6%8F%92%E4%BB%B6%E5%AE%9E%E9%AA%8C%E5%AE%A4)

面向 [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) 工具和插件的、可复现的确定性基准证据协议。

本项目不会复制已有的 `dsh-batch-regression`：后者侧重把一条 shell 命令重复 N 次并统计中位数/分布；`dsh-benchmark` 固定的是完整证据链——显式 target/suite revision、由文件重算的目标指纹、固定 cases、argv-only 受限子进程、逐次原始测量、带版本的判分规则、内容寻址报告以及基线回归比较。

首版只评价命令和 JSONL runner 的确定性行为，不直接评价 LLM 主观质量。

0.2.0 同时是正式 Codex 插件和独立的 proof-only MCP server，并采用真实 DSH Web Loader 所要求的命名空间导出形态；仓库内有真实 Cordis 启动回归，防止加载契约再次漂移。

外部相邻方案多在评估 Skill 或 LLM 质量；本项目坚持做确定性执行证据层：固定目标 revision 和 cases，保留有界原始测量但不保留业务原文，使用版本化判分器、内容寻址报告与基线回归判决。

## 证据内容

manifest 明确冻结：

- 基准套件名称和 cases revision；
- 被测目标名称、声明 revision 以及用于重算指纹的文件；
- 可执行文件、受限 cwd、warmup/repeat、超时、输出上限和并发上限；
- 每个 case 的固定 argv 与可选 JSONL stdin；
- 期望退出码、stdout/stderr SHA-256、可选 JSONL 行数；
- 判分器版本、最低通过率、输出稳定性要求、最大中位延迟回归阈值。

每次 warmup 和正式测量都会留下：纳秒耗时、退出码、信号、是否超时/超输出、输出字节数和哈希、JSONL 合法性，以及每条 expectation 的判定。报告不包含原始 argv、stdin、stdout、stderr、继承环境、时间戳或主机名。

## 安全边界

- 强制 `shell: false`，不接受 shell 命令串和拼接。
- `node` 映射到当前绝对 `process.execPath`；其他可执行文件必须是工作区内的显式相对路径，不做 PATH 搜索。
- cwd、目标文件、manifest、报告和 artifactDir 都禁止路径穿越与符号链接逃逸。
- 子进程使用最小确定性环境，不继承调用方秘密。
- 超时、输出字节上限和并发上限都有清单级硬边界。
- token、Cookie、Authorization、密码、凭证和自定义秘密环境字段直接拒绝。
- 报告只存哈希和测量值，不存命令输入和输出正文。
- 只向显式 artifactDir 内容寻址、独占写入，并在落盘后回读校验 SHA-256。

只运行可信的被测程序。上述边界防止意外 shell 展开和环境泄密，但不代替针对恶意程序的操作系统沙箱。

## 安装到 DSH

```bash
dsh plugin --profile benchmark add github:dongsheng123132/dsh-benchmark
```

插件注册三个工具：

- `dsh_benchmark_inspect`：不执行命令，只检查协议、cases 和指纹。
- `dsh_benchmark_run`：运行固定 cases，生成内容寻址报告。
- `dsh_benchmark_compare`：按 manifest 阈值比较当前报告与基线。

## MCP

`.mcp.json` 声明独立 stdio MCP server：

- `benchmark_manifest_lint`：验证内联清单，只返回标识、边界策略以及 runner/case 输入哈希。
- `benchmark_report_address`：重新计算报告精确 SHA-256，返回有界摘要，并拒绝原始输出与秘密形字段。

MCP 只接受有界内联 JSON，不执行命令，也不读写文件系统。真实 benchmark 执行只保留在受 workspace 限制的 DSH 工具和 CLI 表面。

## 命令行

```bash
dsh-benchmark inspect --root D:/project --manifest benchmark.json
dsh-benchmark run --root D:/project --manifest benchmark.json --artifact-dir artifacts
dsh-benchmark compare --root D:/project --manifest benchmark.json --baseline artifacts/baseline.json --current artifacts/current.json --artifact-dir comparisons
```

退出码 `0` 为通过；`2` 表示报告/比较已成功写出，但判分未通过；`1` 表示清单或运行错误。

完整 JSONL 示例见 [`examples/benchmark.example.json`](examples/benchmark.example.json)。

## 开发验证

```bash
npm test
npm run check
npm run smoke:plugin
npm run smoke:mcp
python C:/Users/ZhuanZ/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py .
```

要求 Node.js 22+。没有安装生命周期脚本；运行依赖只有可选的 DSH tools SDK peer。

## 许可证

MIT
