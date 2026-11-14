# dsh-cleaner

[English](README.md) | 中文

[![ci](https://github.com/FrozenYty/dsh-cleaner/actions/workflows/ci.yml/badge.svg)](https://github.com/FrozenYty/dsh-cleaner/actions/workflows/ci.yml)
![license](https://img.shields.io/badge/license-MIT-blue)
![dependencies](https://img.shields.io/badge/dependencies-none-brightgreen)
![build step](https://img.shields.io/badge/build-none-brightgreen)
![dsh](https://img.shields.io/badge/dsh-0.2.2--rc.1-blue)

> 只删日志，不碰在用。

一个 DeepSeek Harness 的 profile bundle，补上产品本身不做的那件事：把会话的日志从磁盘上真正删掉。它列出还在占
地方的东西，等人做决定，只删被点名的那几个 id，并报告回收了多少字节。没有定时器，没有“多久没动就删”的阈值，
没有后台清扫，**也不需要先归档**——归档只是侧边栏把会话藏起来的方式，不是删除它的许可证。

[github.com/FrozenYty/dsh-cleaner](https://github.com/FrozenYty/dsh-cleaner)

## 状态

- 当前版本：v0.2.4。
- **在这台机器的真实 profile 里跑过**（2026-11-13）：从这个目录装进 desktop profile 后两个工具都出现了，
  `list_session_logs` 列出 6 个日志，`delete_session_logs` 只删掉这 6 个目录——回收
  4,169,349 字节，失败 0、拒绝 0。挂载着的 `sessionPersistence` 后端确认已不再列出它们；再列一次是 0 个
  候选、6 个全部报成 already gone；独立清点目录也一致：删前 36 个会话目录，删后 30 个，正在跑的会话没被动。
- **用宿主自己的 schema 校验器验过**（从已安装的 `0.2.2-rc.1` asar 里取出）：两个输出 schema 通过
  `assertSupportedJsonSchema`——这正是 `tools.register()` 在工具存在之前会跑的检查；两个参数 schema 通过更
  严格的 object-root 断言，并且只接受工具文档里写的那种调用形状（多一个参数、该给数组却给了字符串、缺必填
  字段，都会被拒）；两个真实返回值也都通过了针对其声明输出 schema 的 `validateJsonSchemaValue`。单靠 schema
  校验器不构成激活证明——上面那次真实运行才是。
- **还没覆盖的**：删除中途失败、真实会话目录里出现链接、以及存储布局与 `0.2.2-rc.1` 不同的 harness 版本。
  前两项有 fixture 测试；第三项失败方向是安全的（0 个候选），见 [docs/design.md](docs/design.md) §8。
- `scripts/check.mjs` 从不加载 Harness，也不该加载：激活是 profile 才能显示的事实，不是仓库能证明的东西。
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
| 列出 | `list_session_logs` | 列出日志还在磁盘上的会话，各自占多少字节、几个文件、最后写入时间，以及是否已归档。没有参数、没有副作用——调它永远不会是个错误。 |
| 确认 | — | 人看清单、批准 id。这一步什么都不会发生。 |
| 删除 | `delete_session_logs` | 只接受点名给出的 id，删掉这些会话目录，报告回收的字节。 |

`delete_session_logs` 必须逐个点名 id，所以默认什么都删不了，也就可以只批准其中几个。已归档和未归档的会话
都能删；它会**拒绝并汇报**的，只有下面这些：

- 正在执行命令的这个会话，以及任何 agent 正**忙**着的会话（拒绝里会写明状态）；
- 磁盘上已经没有目录的 id；
- 本插件不肯碰的会话目录：一个链接，或者里面不只有普通文件。

同一个操作也是一个**人类命令**，所以删除不必花掉一次模型往返。它的名字是 `clean`，在输入框里以斜杠开头：

```
/clean                     → 清单，直接作为文本出现在对话里
/clean <id> <id> …         → 只删这几个，并报告回收的字节
```

它走的是宿主的命令注册表（`ctx.remote.commands.execute`）：注册表解析命令并直接执行，**不把任何东西发给
模型**——没有回合、没有请求、不为一个你已经做完的决定再花一次上下文。两个调用者最终都落在同一份实现上，
所以人打的命令和模型调的工具不可能给出不一样的答案（[ADR 0011](docs/adr/0011-one-operation-two-callers.md)）。

会话自己的 **⋯ 菜单**里有同一件事的一行：*删除会话*（中文窗口）／*Delete session*（英文窗口），红色、带产品自己的
垃圾桶图标，排序在所有会话动作之后，旁边印着 **Ctrl+Shift+D**（macOS 是 ⌘⇧D）。这个键删掉窗口正在看的那个会话，
而且它是产品快捷键表里的一条真实绑定：会出现在快捷键设置里，也能在那里改键。这是一条**数据贡献**，不是渲染器：
bundle 只给出标签、图标键、按键和点击之后做什么，菜单由侧边栏按它自己的动作画。这一行**只在宿主真的有 `clean`
命令时才出现**：浏览器半边随页面加载更新，宿主半边只随进程更新，而一条宿主不认识的命令会让点击退化成普通文本，
读起来就像一次根本没发生过的“删除失败”。

## 安装

profile 链接的是目录，所以跑起来的就是你 clone 下来的那份代码——放在一个能长期留着的位置：

```sh
git clone https://github.com/FrozenYty/dsh-cleaner.git ~/code/dsh-cleaner
```

然后把这个绝对路径装进你在用的 profile。桌面版里直接说一句就行：模型会用 `plugin_manager` 的
`install_bundle` 带上这个路径——本仓库验证过的就是这条路。CLI 自己管的 profile（`web`、`headless`、
`sdk`）用 `dsh plugin` 装同一个路径，它转发给 pnpm：

```sh
dsh plugin --profile web add ~/code/dsh-cleaner
```

没有构建步骤、没有依赖、没有安装脚本：`index.js` 和 `engine.js` 只用 `node:` 内置模块和彼此。

**更新**是在那个 clone 里 `git pull` 再重启应用：宿主只在启动时读 bundle，正在运行的窗口用的还是它加载
时的那份代码。**卸载**是 `plugin_manager` 的 `remove_bundle`，CLI 管的 profile 用
`dsh plugin --profile <name> remove dsh-cleaner`；clone、存储、以及已经删掉的东西都不受影响。

装好之后，插件列表里那张卡的标题是**清理**、描述是`只删日志，不碰在用。`——卡片在、开关是开的，就说明
bundle 加载成功了。

## 第一次使用

没有界面要打开：正常说话，模型去调工具。下面这段来自[状态](#状态)里记录的那次真实运行：

```
> 还有哪些会话在占地方？

list_session_logs {}
← Session logs on disk: 6, 4169349 bytes (3.98 MiB) (6 of them archived).
  The session store holds 36 directories, 94607680 bytes (90.22 MiB) in all.
    "导入 Claude Code 聊天记录"  session-36560858-…  182051 bytes (177.8 KiB)  3 files  archived  last write 2026-11-02T07:39:15.053Z
    "询问模型身份"  session-177a4f1f-…  2475067 bytes (2.36 MiB)  1 file  archived  last write 2026-11-03T02:14:07.060Z
    …
  Nothing was deleted. Show this list to the person and call delete_session_logs with the ids
  they approve — archived or not.

> 清单上那六个，全删。

delete_session_logs { session_ids: ["session-36560858-…", "session-177a4f1f-…", …] }
← Deleted 6 session directories: 4169349 bytes (3.98 MiB) reclaimed.
    "导入 Claude Code 聊天记录"  session-36560858-…  182051 bytes (177.8 KiB)  3 files    …
  The workspace records dropped them (6 detached): an archived session is hidden by the sidebar, so
  the rows are gone from every open window without a reload.
  The session persistence backend no longer lists any of them.
```

## 它绝不做什么

- 绝不碰正在执行命令的这个会话，也不碰任何 agent 正**忙**着的会话——拒绝里会写明状态，这样“等它干完”和
  “插件因为看不见的原因拒绝了”能分得清。宿主只是把 agent 留在内存里（闲置），不构成阻塞
  （[ADR 0008](docs/adr/0008-busy-not-resident.md)）。
- 绝不删没人点名过的东西。存储本身就是索引——日志还在磁盘上的会话都是候选，归档与否都一样——而删除工具
  拿到的 id，永远来自清单打印出来的那一份。
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
- `<DSH_HOME>/storages/workspace.json` —— 只读，用来看 `global.archivedSessionIds`：清单里那个“是否已
  归档”的标记，以及更早的删除可能留下的 id。它不是门槛——没有归档记录的会话，照样是候选。
- `<DSH_HOME>/storages/session_projcache/sessions/<id>.json` —— 只读，只为一行：会话标题。它显示在 id
  旁边，好让一串 id 能对上你记得名字的那些会话。文件缺失、版本更旧或读不出来，只损失标题，别的都不受影响。

workspace 文件永远不写，项目里的会话列表也不是插件写的：它**请** registry 把这些 id 从项目里摘掉，并且
**归档**它们——这才是让那一行消失的开关（[ADR 0006](docs/adr/0006-detach-by-asking.md)）。侧边栏不画任何已归档
会话，而 registry 会把这次改动推送给每个打开的窗口，所以**那一行当场就没了：不用刷新、不用重启、不用切排序**
（[ADR 0012](docs/adr/0012-archive-never-unarchive.md)）。**绝不取消归档**是关键：那个调用属于“恢复”，也正是它
过去把已删会话的那一行重新摆回屏幕上。唯一宿主事件碰不到的那份副本是窗口自己持久化的侧边栏视图，bundle 的浏览器
半边会在每次页面加载时清一遍（[ADR 0007](docs/adr/0007-browser-half-prunes-the-view.md)）。

## 它不做什么

- **不取消归档、不重新归档、不 pin。** 它只删日志，然后请 registry 做两件让那一行消失的记录改动：把会话从
  项目里摘掉、把它归档。第二条就是“删除不需要刷新”的原因——侧边栏不画已归档的行
  （[ADR 0012](docs/adr/0012-archive-never-unarchive.md)）。插件自己一个 workspace 记录都不写
  （[ADR 0006](docs/adr/0006-detach-by-asking.md)）。
- **绝不删正在干活的会话。** 执行这条命令的会话永远保留；任何 agent 还在忙的会话也保留，而且拒绝里会写明状态
  （`a live agent holds this session (status: running)`），这样这个理由是人能处理的信息。agent 只是**驻留**在内存里
  （归档的活已经停了）不构成阻塞（[ADR 0008](docs/adr/0008-busy-not-resident.md)）。
- **不清投影缓存。** harness 把每个会话的投影放在 `storages/session_projcache/`，本插件只从里面读一行
  ——显示在 id 旁边的标题——什么都不写：删掉的会话可能留一条陈旧投影和缓存文件，直到运行时自己改写或丢弃。
  那是派生数据、会自愈，也比为了一个名字去解析日志便宜。
- **不清附件。** 会话带过的图片和文件在内容寻址的仓库里（`attachments/v1/objects`），不在会话目录里：
  一个对象可能同时属于好几个会话，而要找出某个会话引用过哪些，就得解析它的日志——正是本插件拒绝做的事。
  写这份文档的机器上那个仓库有 54 MiB，原样留着。
- **没有定时、没有保留策略、没有大小上限。** 删不删是决定，不是规则。
- **证明不了“人批准过这份清单”。** id 让被批准的集合在对话里明确可见，各条拒绝规则也把损害限制住了，
  但模型仍然可以点一个没人看过的 id。见 [ADR 0003](docs/adr/0003-two-tools-with-explicit-ids.md)。
- **不修日志。** 日志损坏、读不出来，只要会话被点名，照样会被删：本插件是清理的最后一条路，所以不能依赖
  日志可解析。

## 它的位置

让一个会话的日志消失，一共有三条路，各自的边界不一样。中间那一列是读 `dsh-session-cleaner` v1.0.2 已发布
的代码得出的，不是照抄它的简介。

| | 本插件 | `dsh-session-cleaner` | 手工删 |
|---|---|---|---|
| 出现在哪 | 两个模型侧工具 | Web 界面菜单项 + HTTP 路由 | 一个 shell |
| 会删什么 | 磁盘上任何会话日志，被人点名 | 任何没有挂 agent 的会话 | glob 匹配到什么就删什么 |
| 正在跑的会话 | 按 id 永远拒绝 | agent 在跑时拒绝 | 不拒绝——glob 不认识它 |
| 报告什么 | 候选、字节、最后写入、存储总量、逐 id 结果 | detach / workspace / 文件数 | 什么都不报 |
| 是否写 workspace 记录 | 请 registry 摘掉刚删的会话，自己从不写这个文件 | 会，它把会话从记录里摘掉 | 不写 |
| id 写错时 | 拒绝并说明原因 | 不适用——id 来自菜单 | 删错会话 |

两者不是包含关系：`dsh-session-cleaner` 从一个菜单项和一条 HTTP 路由进入，点一下就删；本插件的全部设计
是为了“删不掉任何没在清单里出现过的东西”——而自 v0.2.0 起，未归档的会话也照样能删，所以“只删已经藏起来
的”这条差别已经不存在了。

## 常见问题

**归档错了，还能救回来吗？**
在删之前都能。本插件从不写归档表，所以文件还在时取消归档照常有效。

**harness 开着的时候能用吗？**
能。它只读 workspace 文件、只 unlink 会话目录，不持有会话存储的任何句柄。正在执行命令的这个会话永远被
拒绝，agent 还在忙的会话也一样。删掉的会话可能在界面上留一行，直到运行时刷新——见上面的投影缓存。

**没归档的会话会被删吗？**
会。归档只是产品把会话藏起来的方式，不是本插件删除它的许可证：存储本身就是索引，所以未归档的会话也是候选，
点名就能删。清单里会显示每个会话是否已归档，因为那决定了那一行是不是本来就已经藏起来了。

**删掉之后还能恢复吗？**
不能。每个会话目录是逐个文件 unlink 掉的，没有回收站可以还原：workspace 里的那条记录还在，记录背后的日志
已经不在了。这也正是界面只有“先列清单、再点名 id”的原因——清单就是你唯一能拿到的预览。

**清单里的“最后写入时间”是什么？**
那个会话目录里最新文件的写入时间，也就是这个会话最后一次追加内容的时间。正是这个事实让“六个全删”变成一
个决定：上面那段对话里的六个，最早的最后写入是 2026-11-02，最晚的是 2026-11-12，除此之外输出里没有任何
东西能把它们区分开。

**清单里的标题是哪来的？**
harness 放在存储旁边的投影缓存——和侧边栏显示的是同一个名字。只读那个文件，从不写；也不会为了找名字去打开
日志。没有标题的会话就只按 id 列出来。

**它怎么知道整个存储有多大？**
每次列清单会把 `sessions/` 下每个项目目录走一遍。这趟遍历也正是“已归档但目录已经不在”的 id 会显示成
already gone 的原因——第二次运行看到的就是这个状态。

## 出问题时

**模型说没有这个工具。**
这个 profile 没加载上 bundle。插件页应该有**清理**这张卡，profile 的 `package.json` 里应该有
`dsh-cleaner`；两样都在而工具还是没有，就重启应用——一个窗口用的是它启动时那份插件清单。

**清单是空的，但磁盘还是满的。**
清单会把整个存储的规模跟它找到的东西放在一起报：什么都没列出来、存储 90 MiB，说明会话已经不在了，占地方的是
本插件不动的两样——投影缓存和附件仓库。

**拒绝理由看不懂。**
理由只有这几条：`a live agent holds this session (status: …)`——它的活还在跑，等它干完；`no session
directory is stored under that id`——同样的 id 又调了一次，或者这个会话在另一个窗口里已经被删；
`its directory is not a candidate: …`——冒号后面写的是本插件不肯碰的那种形状（一个链接，或者目录里有不是
普通文件的东西）。

**删除结果里出现 `Partially removed`。**
某个文件 unlink 不掉，通常是索引器或杀毒软件占着。答案会点名是哪个文件、已经释放了多少字节；目录还在，
这个 id 仍然是候选，所以同一条调用再跑一次就行。

**更新之后卡片还是旧的描述。**
宿主只在启动时读 bundle：`git pull` 更新的是文件，正在运行的窗口用的还是它加载时的代码和语言包。重启。

**删掉的会话还在侧边栏里。**
不该还在：插件在删除的同时把会话**归档**了，而侧边栏从不画已归档的会话，所以 registry 的改动到达窗口的那一刻
那一行就没了——那是实时推送，不是刷新。留下的是记录，不是行：归档表里有一个“没有目录的 id”，清单会把它报成
already gone，只有你把归档筛选切到 *显示* 或 *只看* 时它才会出现。如果确实还画着一行，说明窗口留的是改动之前
的副本：刷新页面会顺带清掉窗口自己持久化的视图，重启则会重建客户端的会话列表。有一种情况是说明而不是修好的：
宿主仍握在内存里的会话，会一直留在客户端那份列表的**名字**里，直到宿主释放它（重启会；没有任何插件 API 能），
答案在这种情况下会直说（`the host holds that session in memory`）。

## 兼容性

- **DSH**：对着已安装的 `0.2.2-rc.1` 桌面版验证。`engine.js` 里的存储布局和 id 转义是从那个版本的
  `app.asar`（`@deepseek-ai/dsh-session-persistence` 及其 JSONL 后端）里读出来的，不是凭记忆写的。以后
  哪个版本改了这两样中的任何一样，是本插件唯一没法自己消化的变化——而且失败方向是安全的：0 个候选、所有
  已归档 id 报成 already gone（见 [docs/design.md](docs/design.md) §8）。
- **会话格式**：一个会话一个目录，里面是 `session.vN.jsonl.zstd` 各代。插件不解析任何格式，所以已经发布的
  每一代、以及将来新加的代，都被“整个目录删掉”这一条覆盖。
- **Node**：`^22.19.0 || >=24.0.0`。CI 在两个大版本、三个平台（Linux / macOS / Windows）上跑的都是
  `npm test`；让测试共用一个进程的那个开关两边拼法不同，`scripts/test.mjs` 按当前版本自己选，所以同一条
  命令在两个版本上都成立。

## 安全

插件信任什么、能被弄成删什么、又绝对碰不到什么：[SECURITY.md](SECURITY.md)。

## 验证

```sh
node scripts/check.mjs     # 清单、依赖面、schema、locale、patch、文档
node --check index.js      # bundle 入口能按 ESM 解析
node --check engine.js
npm test                   # fixture 测试，故意只用一个进程
```

测试故意共用一个进程：默认 runner 会按文件各起一个进程，而受限沙箱拒绝那种 spawn。Node 24 把开关拼作
`--test-isolation`，Node 22 拼作 `--experimental-test-isolation`，所以由 `scripts/test.mjs` 按当前版本
选，而不是在 package.json、CI 和这里各写一份。CI 在两个大版本、三个平台上跑的就是这条 `npm test`，
所以拼法和平台是绿出来的，不是声称的。

没有任何测试碰真实 `DSH_HOME`。引擎把会话存储根目录和 workspace 存储文件当参数收，引擎测试全传 fixture
路径，入口测试把 `DSH_HOME` 指到自己的目录。对真实存储的 dry-run 是另一件刻意的事：

```sh
node -e "import('./engine.js').then(async (m) => console.log(JSON.stringify(await m.planCleanup({
  sessionsRoot: process.env.DSH_HOME + '/sessions',
  workspaceFile: process.env.DSH_HOME + '/storages/workspace.json',
}), null, 2)))"
```

`planCleanup` 只读，任何时候跑都安全，也正是 `list_session_logs` 调的那个函数。它永远不删；
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
| 为什么删掉的会话是“请” registry 摘掉，而不是自己改 workspace 文件？ | [ADR 0006](docs/adr/0006-detach-by-asking.md) |
| 为什么 bundle 里带一个浏览器半边？ | [ADR 0007](docs/adr/0007-browser-half-prunes-the-view.md) |
| 为什么 agent 忙就拒绝、只是驻留就不拒绝？ | [ADR 0008](docs/adr/0008-busy-not-resident.md) |
| 一次删除会碰哪些 workspace 记录？ | [ADR 0009](docs/adr/0009-two-records-two-cases.md)（已被取代） |
| 为什么删掉的那一行会当场消失？ | [ADR 0012](docs/adr/0012-archive-never-unarchive.md) |
| 为什么归档不再是前提？ | [ADR 0010](docs/adr/0010-no-archive-precondition.md) |
| 为什么除了工具还有一条命令？ | [ADR 0011](docs/adr/0011-one-operation-two-callers.md) |
| 每个版本包含什么？ | [CHANGELOG.md](CHANGELOG.md) |
| 它可能被弄成删什么，又信任什么？ | [SECURITY.md](SECURITY.md) |
| 怎么开分支、写提交、合并？ | [CONTRIBUTING.md](CONTRIBUTING.md) |
| 助手在这里要守什么规则？ | [AGENTS.md](AGENTS.md) |
