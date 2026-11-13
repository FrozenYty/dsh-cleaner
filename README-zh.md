# dsh-cleaner

[English](README.md) | 中文

[![ci](https://github.com/FrozenYty/dsh-cleaner/actions/workflows/ci.yml/badge.svg)](https://github.com/FrozenYty/dsh-cleaner/actions/workflows/ci.yml)
![license](https://img.shields.io/badge/license-MIT-blue)
![dependencies](https://img.shields.io/badge/dependencies-none-brightgreen)
![build step](https://img.shields.io/badge/build-none-brightgreen)
![dsh](https://img.shields.io/badge/dsh-0.2.2--rc.1-blue)

> 归档只是把它藏起来；删不删，是人的决定。

一个 DeepSeek Harness 的 profile bundle，补上产品本身不做的那件事：把已归档会话的日志从磁盘上真正删掉。
它列出还在占地方的东西，等人做决定，只删被点名的那几个 id，并报告回收了多少字节。没有定时器，没有
“多久没动就删”的阈值，没有后台清扫。

[github.com/FrozenYty/dsh-cleaner](https://github.com/FrozenYty/dsh-cleaner)

## 状态

- 当前版本：v0.1.0。
- **对着真实存储跑过，但没有装进 profile**：一次 dry-run 列出 6 个已归档日志，与独立手工清点一致
  （8 个文件、4,169,349 字节）；随后在真实存储的**副本**上完整排练了一次删除——删前 36 个会话目录，
  删后 30 个，失败 0、拒绝 0。真实存储全程没有被写过，36 个目录一个不少。这一条**不包含**一次真实的
  模型调用：每一层能证明什么，见[验证](#验证)。
- **用宿主自己的 schema 校验器验过**（从已安装的 `0.2.2-rc.1` asar 里取出）：两个输出 schema 通过
  `assertSupportedJsonSchema`——这正是 `tools.register()` 在工具存在之前会跑的检查；两个参数 schema 通过更
  严格的 object-root 断言，并且只接受工具文档里写的那种调用形状（多一个参数、该给数组却给了字符串、缺必填
  字段，都会被拒）；两个真实返回值也都通过了针对其声明输出 schema 的 `validateJsonSchemaValue`。这仍然
  **不是**激活证明：没有任何 profile 加载过这个插件。
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
  The session store holds 36 directories, 91902898 bytes (87.65 MiB) in all.
    session-36560858-…  182051 bytes (177.8 KiB)  3 file(s)  last write 2026-11-02T07:39:15.053Z
    session-177a4f1f-…  2475067 bytes (2.36 MiB)  1 file(s)  last write 2026-11-03T02:14:07.060Z
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
- **不清附件。** 会话带过的图片和文件在内容寻址的仓库里（`attachments/v1/objects`），不在会话目录里：
  一个对象可能同时属于好几个会话，而要找出某个会话引用过哪些，就得解析它的日志——正是本插件拒绝做的事。
  写这份文档的机器上那个仓库有 54 MiB，原样留着。
- **没有定时、没有保留策略、没有大小上限。** 删不删是决定，不是规则。
- **证明不了“人批准过这份清单”。** id 让被批准的集合在对话里明确可见，各条拒绝规则也把损害限制住了，
  但模型仍然可以点一个没人看过的 id。见 [ADR 0003](docs/adr/0003-two-tools-with-explicit-ids.md)。
- **不修日志。** 会话已归档但日志损坏、读不出来，照样会被删：本插件是清理的最后一条路，所以不能依赖日志
  可解析。

## 它的位置

让一个会话的日志消失，一共有三条路，各自的边界不一样。中间那一列是读 `dsh-session-cleaner` v1.0.2 已发布
的代码得出的，不是照抄它的简介。

| | 本插件 | `dsh-session-cleaner` | 手工删 |
|---|---|---|---|
| 出现在哪 | 两个模型侧工具 | Web 界面菜单项 + HTTP 路由 | 一个 shell |
| 会删什么 | 只有已归档、且被人点名的 id | 任何没有挂 agent 的会话 | glob 匹配到什么就删什么 |
| 正在跑的会话 | 按 id 永远拒绝 | agent 在跑时拒绝 | 不拒绝——glob 不认识它 |
| 报告什么 | 候选、字节、最后写入、存储总量、逐 id 结果 | detach / workspace / 文件数 | 什么都不报 |
| 是否写 workspace 记录 | 从不 | 会，它把会话从记录里摘掉 | 不写 |
| id 写错时 | 拒绝并说明原因 | 不适用——id 来自菜单 | 删错会话 |

两者不是包含关系：`dsh-session-cleaner` 删的是“任何会话”并顺手清理 workspace 记录，这正是点菜单的人想要
的；本插件只删已经藏起来的东西，而它的全部设计就是为了“删不掉别的”。

## 常见问题

**归档错了，还能救回来吗？**
在删之前都能。本插件从不写归档表，所以文件还在时取消归档照常有效；而在你看过清单之后又被取消归档的会话，
删除那一步会点名拒绝它。

**harness 开着的时候能用吗？**
能。它只读 workspace 文件、只 unlink 会话目录，不持有会话存储的任何句柄。正在执行命令的这个会话永远被
拒绝，被活着的 agent 占着的会话也一样。删掉的会话可能在界面上留一行，直到运行时刷新——见上面的投影缓存。

**没归档的会话会被删吗？**
不会。候选集就是归档表，按 id 去查；未归档的会话根本不会被查到，而不是“查出来再过滤掉”。

**清单里的“最后写入时间”是什么？**
那个会话目录里最新文件的写入时间，也就是这个会话最后一次追加内容的时间。正是这个事实让“六个全删”变成一
个决定：这六个里最早的最后写入是 2026-11-02，最晚的是 2026-11-12，除此之外输出里没有任何东西能把它们
区分开。

**它怎么知道整个存储有多大？**
每次列清单会把 `sessions/` 下每个项目目录走一遍。这趟遍历也正是“已归档但目录已经不在”的 id 会显示成
already gone 的原因——第二次运行看到的就是这个状态。

## 兼容性

- **DSH**：对着已安装的 `0.2.2-rc.1` 桌面版验证。`engine.js` 里的存储布局和 id 转义是从那个版本的
  `app.asar`（`@deepseek-ai/dsh-session-persistence` 及其 JSONL 后端）里读出来的，不是凭记忆写的。以后
  哪个版本改了这两样中的任何一样，是本插件唯一没法自己消化的变化——而且失败方向是安全的：0 个候选、所有
  已归档 id 报成 already gone（见 [docs/design.md](docs/design.md) §8）。
- **会话格式**：一个会话一个目录，里面是 `session.vN.jsonl.zstd` 各代。插件不解析任何格式，所以已经发布的
  每一代、以及将来新加的代，都被“整个目录删掉”这一条覆盖。
- **Node**：`^22.19.0 || >=24.0.0`。CI 在两个大版本、两个平台上都跑测试；隔离开关两边拼法不同（24 上是
  `--test-isolation=none`，与本机一致；22 上是 `--experimental-test-isolation=none`）。

## 安全

插件信任什么、能被弄成删什么、又绝对碰不到什么：[SECURITY.md](SECURITY.md)。

## 验证

```sh
node scripts/check.mjs                              # 清单、依赖面、schema、locale、patch、文档
node --check index.js                               # bundle 入口能按 ESM 解析
node --check engine.js
node --test --test-isolation=none tests/*.test.mjs  # fixture 测试，故意只用一个进程
```

`--test-isolation=none` 是这台机器的必须项：默认 runner 会按文件各起一个进程，而这个沙箱拒绝那种 spawn。
它同时是 Node 24 的拼法；Node 22 叫 `--experimental-test-isolation`。CI 在两个大版本、两个平台上各跑一遍，
所以拼法和平台都是被绿过的，不是声称的。

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
| 为什么执行时还要把 plan 再核一遍？ | [ADR 0005](docs/adr/0005-re-verify-at-execution.md) |
| 每个版本包含什么？ | [CHANGELOG.md](CHANGELOG.md) |
| 它可能被弄成删什么，又信任什么？ | [SECURITY.md](SECURITY.md) |
| 怎么开分支、写提交、合并？ | [CONTRIBUTING.md](CONTRIBUTING.md) |
| 助手在这里要守什么规则？ | [AGENTS.md](AGENTS.md) |
