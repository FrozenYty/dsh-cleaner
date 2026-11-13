# dsh-cleaner

[English](README.md) | 中文

> 归档只是把它藏起来；删不删，是人的决定。

一个 DeepSeek Harness 的 profile bundle，补上产品本身不做的那件事：把已归档会话的日志从磁盘上真正删掉。
它列出还在占地方的东西，等人做决定，只删被点名的那几个 id，并报告回收了多少字节。没有定时器，没有
“多久没动就删”的阈值，没有后台清扫。

[github.com/FrozenYty/dsh-cleaner](https://github.com/FrozenYty/dsh-cleaner)

## 状态

- 当前版本：v0.1.0。
- **对着真实存储跑过，但没有装进 profile**：一次 dry-run 列出 6 个已归档日志，与独立手工清点一致
  （8 个文件、4,169,349 字节）；随后在真实存储的**副本**上完整排练了一次删除——删前 36 个会话目录，
  删后 30 个，失败 0、拒绝 0。真实存储全程没有被写过。
- **只有单元测试，未在 profile 里跑过**：两个工具包装在真实 Host 下的调用、`sessionPersistence` 核对
  步骤接真实后端的样子，以及所有和“能否激活”有关的事。`tests/` 就是存在的清单。
- **这里根本证明不了**：`scripts/check.mjs` 从不加载 Harness，所以本仓库没有任何东西能证明插件会激活。
  只有装一次才能，而装一次有真实副作用，所以每次都该由人决定。
- 版本列表：[CHANGELOG.md](CHANGELOG.md)。机制与候选状态矩阵：[docs/design.md](docs/design.md)。
  决策记录：[ADR](docs/adr/)。

## 契约

在 DeepSeek Harness 里“归档”只是把会话藏起来，日志永远留在磁盘上。产品里没有任何东西会删它，官方持久化
缝也删不了——`@deepseek-ai/dsh-session-persistence` 把 “No deletion or retention API — pruning stored
sessions is out-of-band backend maintenance” 写在已知限制里，JSONL 后端更是直说：“Nothing deletes
session files”。这个 bundle 就是那次外部清理，它只守一条规矩：

**删除是有人要求的刻意动作，永远不是定时器。** 插件里没有 timer、没有 interval、没有年龄阈值、没有后台
清扫，profile 也没法给它配一个出来。只有在人看过清单之后的那次工具调用里，才会发生删除。

两个工具对应三个步骤：

| 步骤 | 工具 | 做什么 |
|---|---|---|
| 列出 | `list_archived_sessions` | 列出日志还在磁盘上的已归档会话，以及各自占多少字节。没有参数、没有副作用——调它永远不会是个错误。 |
| 确认 | — | 人看清单、批准 id。这一步什么都不会发生。 |
| 删除 | `delete_archived_sessions` | 只接受点名给出的 id，删掉这些会话目录，报告回收的字节。 |

`delete_archived_sessions` 必须逐个点名 id，所以默认什么都删不了，也就可以只批准其中几个。下面这些情况它
会**拒绝并汇报**，而不是让整次调用失败：

- 没归档的会话，以及已归档但磁盘上已经没有目录的会话；
- 正在执行命令的这个会话，以及任何被活着的 agent 占着的会话；
- 列表给你看过之后又被取消归档的会话——归档表在删除那一刻重读，不沿用列表时的快照。

## 安装

装不装是人的决定，不是 bundle 的：

```sh
dsh plugin --profile <profile> add /path/to/dsh-cleaner
```

没有构建步骤、没有依赖、没有安装脚本：`index.js` 和 `engine.js` 只用 `node:` 内置模块和彼此。安装会把
这个工作目录链接进 profile，跑的就是这个目录。

## 第一次使用

没有界面要打开：正常说话，模型去调工具。下面这段来自上面那次排练：

```
> 还有哪些已归档会话在占地方？

list_archived_sessions {}
← Archived session logs on disk: 6 of 6 archived ids, 4169349 bytes (3.98 MiB).
    session-36560858-…  182051 bytes  3 file(s)
    session-177a4f1f-…  2475067 bytes  1 file(s)
    …
  Nothing was deleted. Show this list to the person and call delete_archived_sessions with the ids
  they approve.

> 清单上那六个，全删。

delete_archived_sessions { session_ids: ["session-36560858-…", "session-177a4f1f-…", …] }
← Deleted 6 session directory(ies): 4169349 bytes (3.98 MiB) reclaimed.
  The session persistence backend no longer lists any of them.
```

## 它绝不做什么

- 绝不碰未归档的会话。它能删的 id 只来自 workspace 存储文件里的 `global.archivedSessionIds`，而且引擎
  只查这些 id——未归档的会话不是被“过滤掉”，而是从构造上就不会成为候选。
- 绝不碰正在执行命令的这个会话，也不碰任何被活着的 agent 占着的会话。
- 绝不跟随链接。项目目录或会话目录是符号链接/目录联接时，只报告、不进入；会话目录里只要有不是普通文件的
  东西，就整个拒绝并说明原因；每个候选在删第一个字节之前都要 `realpath` 到存储根之内；文件是逐个
  `unlink` 的，不把整棵树交给递归删除。
- 绝不打开会话日志、读一个事件、改一行。删除的单位是会话自己的目录，整个删——不解析任何会话格式，所以
  未来任何新格式都不会被它误读。

## 它在哪儿干活

`DSH_HOME`（默认 `~/.dsh`），下面两条路径是引擎的入参：

- `<DSH_HOME>/sessions/<project-key>/<session-id>/` —— 会话自己的目录，布局来自
  `dsh-session-persistence-jsonl`（里面是 `session.vN.jsonl.zstd` 各代）。目录名是后端对 id 的转义，
  在 `engine.js` 里照抄了一份；目录里的每一代都属于同一个会话，一起删。
- `<DSH_HOME>/storages/workspace.json` —— 只读，用来看 `global.archivedSessionIds`。

workspace 文件永远不写。删掉的 id 会留在归档表里，只是变成一个“没有目录的 id”，清单会把它报成
already gone。

## 它不做什么

- **不取消归档、不重新归档、不 pin。** 它只删日志；归档表和 workspace 记录归 harness 管。
- **不清投影缓存。** harness 把每个会话的投影放在 `storages/session_projcache/`，本插件不碰：删掉的会话
  可能留一条陈旧投影和缓存文件，直到运行时自己改写或丢弃。那是派生数据、会自愈，也刻意不让它成为引擎的
  第三条可能搞错的路径。
- **没有定时、没有保留策略、没有大小上限。** 删不删是决定，不是规则。
- **证明不了“人批准过这份清单”。** id 让被批准的集合在对话里明确可见，各条拒绝规则也把损害限制住了，
  但模型仍然可以点一个没人看过的 id。见 [ADR 0003](docs/adr/0003-two-tools-with-explicit-ids.md)。
- **不修日志。** 会话已归档但日志损坏、读不出来，照样会被删：本插件是清理的最后一条路，所以不能依赖日志
  可解析。

## 验证

```sh
node scripts/check.mjs                              # 清单、依赖面、schema、locale、patch、文档
node --check index.js                               # bundle 入口能按 ESM 解析
node --check engine.js
node --test --test-isolation=none tests/*.test.mjs  # 20 个 fixture 测试，故意只用一个进程
```

`--test-isolation=none` 是这台机器的必须项：默认 runner 会按文件各起一个进程，而这个沙箱拒绝那种 spawn。
它同时是 Node 24 的拼法；Node 22 叫 `--experimental-test-isolation`，所以本机和 CI 都跑 Node 24、用同
一条命令。CI 在 Linux 和 Windows 上各跑一遍。

没有任何测试碰真实 `DSH_HOME`。引擎把会话存储根目录和 workspace 存储文件当参数收，引擎测试全传 fixture
路径，入口测试把 `DSH_HOME` 指到自己的目录。对真实存储的 dry-run 是另一件刻意的事：

```sh
node -e "import('./engine.js').then(async (m) => console.log(JSON.stringify(await m.planCleanup({
  sessionsRoot: process.env.DSH_HOME + '/sessions',
  workspaceFile: process.env.DSH_HOME + '/storages/workspace.json',
}), null, 2)))"
```

`planCleanup` 只读，任何时候跑都安全，也正是 `list_archived_sessions` 调的那个函数。它永远不删；
`applyCleanup` 是唯一会删的函数。

## 文档

| 问题 | 文档 |
|---|---|
| 插件承诺什么，怎么装？ | 本 README |
| 它怎么守住这些承诺，什么算候选？ | [docs/design.md](docs/design.md) |
| 为什么删除走带外，持久化缝到底提供什么？ | [ADR 0001](docs/adr/0001-out-of-band-deletion.md) |
| 为什么 bundle 这一半什么都不 import？ | [ADR 0002](docs/adr/0002-zero-import-bundle-half.md) |
| 为什么是两个工具，为什么必须点名 id？ | [ADR 0003](docs/adr/0003-two-tools-with-explicit-ids.md) |
| 为什么链接和不规则目录只拒绝、不跟随？ | [ADR 0004](docs/adr/0004-refuse-links.md) |
| 每个版本包含什么？ | [CHANGELOG.md](CHANGELOG.md) |
| 怎么开分支、写提交、合并？ | [CONTRIBUTING.md](CONTRIBUTING.md) |
| 助手在这里要守什么规则？ | [AGENTS.md](AGENTS.md) |
