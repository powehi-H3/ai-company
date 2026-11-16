# DSH-Go 官方 root 通道 · 完整方法记录

- 记录时间：2026-11-16
- 来源：https://github.com/ghjicb/dsh-Go（fork 自 `ccch1mneyyy/dsh-Go`）
- 原始源码：本目录下 `参考源码-DSHGo官方/`（16 个 .kt，共 197KB）
- 许可：MIT（`SPDX-License-Identifier: MIT`），作者 CikeSeven / qiannianhuanxiang
- 记录人：DSH（总经理）

> 本文是**方法记录**，把它怎么做的写全，不只是"经验总结"。
> 想直接看代码的去 `参考源码-DSHGo官方/`。

---

## 零、总览

**一句话**：`su -c` 起一个 Java 进程（`app_process`），用**进程的 stdin/stdout 走二进制帧协议**。

**不用**：KSU 模块、守护进程、文件队列、FIFO、端口、Binder（adb 路径）。

### 架构图

```
┌─────────────────────────────────────┐
│  DSH-Go App 进程 (uid=10458)         │
│                                      │
│  RootStarter.start()                 │
│    ↓ ProcessBuilder("su","-c",...)   │
│  RootProcess                         │
│    · inputStream  ← 响应帧           │
│    · outputStream → 请求帧           │
└──────────────┬───────────────────────┘
               │ 管道（4字节长度 + Bundle）
┌──────────────▼───────────────────────┐
│  app_process 进程 (uid=0)            │
│                                      │
│  PrivilegedDisplayMain.main()        │
│    · 先写 MAGIC "DSHV"               │
│    · 循环 Frames.read → core.handle  │
│    · Frames.write 响应               │
└──────────────────────────────────────┘
```

### 16 个文件的分工

| 文件 | 大小 | 干什么 |
|---|---|---|
| `PrivilegedCommands.kt` | 961 B | 拼 `su -c` 命令 |
| `RootProcess.kt` | 3,883 B | 包 `Process`，管管道、超时、stderr 抽干 |
| `RootStarter.kt` | 9,236 B | 启动流程 + 四步握手 + 状态机 |
| `RootStatus.kt` | 2,021 B | 状态快照 |
| `PrivilegedProtocol.kt` | 18,870 B | 帧格式 + Bundle 序列化 + 所有协议常量 |
| `FramedMuxSession.kt` | 4,364 B | **客户端侧**多路复用（并发请求） |
| `FramedMuxServer.kt` | 2,282 B | **服务端侧**多路复用 |
| `MuxProtocol.kt` | 3,266 B | 多路复用的信封格式与校验 |
| `PrivilegedDisplayEntry.kt` | 7,368 B | root 侧程序入口（`main` + Shizuku Service） |
| `PrivilegedDisplayHost.kt` | 6,678 B | 引擎宿主 |
| `PrivilegedDisplayCore.kt` | 122,486 B | 真正的干活逻辑（122KB，极大） |
| `PrivilegedChannel.kt` | 5,448 B | 对外暴露的通道接口 |
| `PrivilegedKeepJob.kt` | 2,906 B | 开机恢复（JobScheduler） |
| `PrivilegedKeepState.kt` | 4,563 B | 「保持 root」的三态选择 |
| `PrivilegedActionGate.kt` | 431 B | 动作闸门 |
| `PrivilegedPathPolicy.kt` | 2,286 B | 路径白名单策略 |

---

## 一、启动：`su -c` 怎么拼

### 源码（`PrivilegedCommands.kt` 全文）

```kotlin
object PrivilegedCommands {
    fun appProcess(sourceDir: String, splitSourceDirs: List<String> = emptyList()): String {
        val paths = listOf(sourceDir) + splitSourceDirs
        require(paths.all { it.startsWith('/') && '\u0000' !in it && ':' !in it })
        return "CLASSPATH=${quote(paths.joinToString(":"))} exec /system/bin/app_process /system/bin ${PrivilegedDisplayMain::class.java.name}"
    }

    private fun quote(value: String): String = "'" + value.replace("'", "'\\''") + "'"
}

/** `su -c` takes exactly one shell command on Magisk, KernelSU and APatch. */
internal object RootCommands {
    fun appProcess(sourceDir: String, splitSourceDirs: List<String> = emptyList()): List<String> =
        listOf("su", "-c", PrivilegedCommands.appProcess(sourceDir, splitSourceDirs))
}
```

### 拆解

最终执行的命令长这样：

```sh
su -c "CLASSPATH='/data/app/~~xxx/base.apk' exec /system/bin/app_process /system/bin io.github...PrivilegedDisplayMain"
```

| 组成 | 为什么 |
|---|---|
| `su -c "<一条命令>"` | Magisk / KernelSU / APatch **都只接受一条** shell 命令。传数组不行。 |
| `CLASSPATH='<apk>'` | 把 App 自己的 APK 当 classpath，这样 `app_process` 能加载里面的类 |
| `exec` | **关键**：替换掉 sh 进程。不加的话会变成 `su → sh → app_process` 三层，管道里多一层，EOF 和信号语义会乱 |
| `/system/bin/app_process` | Android 自带的启动 JVM 的二进制 |
| `/system/bin` | `app_process` 的参数：程序名 |
| `<类名>` | 要跑的 Java 类的全限定名 |

### 安全检查（三处，缺一不可）

```kotlin
require(paths.all { it.startsWith('/') && '\u0000' !in it && ':' !in it })
```
- `startsWith('/')`：必须是绝对路径
- `'\u0000' !in it`：不能有 NUL（截断注入）
- `':' !in it`：不能有冒号（`CLASSPATH` 用冒号分隔，会注入额外条目）

```kotlin
private fun quote(value: String): String = "'" + value.replace("'", "'\\''") + "'"
```
- 单引号包裹
- 内部的单引号替换成 `'\''`（标准的 shell 单引号转义）

---

## 二、帧格式：`PrivilegedProtocol.kt`

### 2.1 魔数常量

```kotlin
object Frames {
    const val MAX = 8 * 1024 * 1024   // 单帧上限 8MB

    /** Written once before the first frame so the reader can skip leading shell/stderr noise. */
    val MAGIC = byteArrayOf('D'.code.toByte(), 'S'.code.toByte(),
                            'H'.code.toByte(), 'V'.code.toByte())   // "DSHV"
}
```

### 2.2 对齐魔数

```kotlin
/** Reads and discards input until [MAGIC] is matched; false at end of stream. */
fun syncToMagic(input: InputStream): Boolean {
    var matched = 0
    while (matched < MAGIC.size) {
        val b = input.read()
        if (b < 0) return false
        matched = if (b.toByte() == MAGIC[matched]) matched + 1
        else if (b.toByte() == MAGIC[0]) 1 else 0
    }
    return true
}
```

**为什么需要**：`su -c` 启动时，su 管理器可能往 stdout 打授权提示。先读到 `DSHV`，之前的全部丢弃。

注意它是**流式状态机**：匹配失败时，如果当前字节等于魔数首字节就回退到 `matched=1`，否则归零。这是标准的子串搜索，避免漏掉重叠匹配。

### 2.3 帧写

```kotlin
fun write(out: OutputStream, payload: ByteArray) {
    require(payload.size <= MAX) { "frame too large" }
    val n = payload.size
    out.write(byteArrayOf((n ushr 24).toByte(), (n ushr 16).toByte(),
                          (n ushr 8).toByte(), n.toByte()))
    out.write(payload)
    out.flush()
}
```

### 2.4 帧读

```kotlin
/** Blocks for a full frame; null at clean end of stream. */
fun read(input: InputStream): ByteArray? {
    val header = readFully(input, 4) ?: return null
    val n = ((header[0].toInt() and 0xff) shl 24) or ((header[1].toInt() and 0xff) shl 16) or
        ((header[2].toInt() and 0xff) shl 8) or (header[3].toInt() and 0xff)
    if (n < 0 || n > MAX) throw java.io.IOException("bad frame length $n")
    return readFully(input, n) ?: throw java.io.IOException("truncated frame")
}

private fun readFully(input: InputStream, n: Int): ByteArray? {
    val buf = ByteArray(n)
    var off = 0
    while (off < n) {
        val r = input.read(buf, off, n - off)
        if (r < 0) return if (off == 0) null else throw java.io.IOException("truncated")
        off += r
    }
    return buf
}
```

### 2.5 帧结构图

```
客户端 → 服务端：
┌──────────────┬──────────────────────┐
│ 4 字节大端长度 │  Bundle(Parcel) 载荷  │
│  n = 0..8MB   │   n 字节             │
└──────────────┴──────────────────────┘

首次之前，服务端先发一次：
┌──────┐
│ DSHV │  ← 4 字节魔数，仅一次
└──────┘
```

### 2.6 载荷序列化

```kotlin
object Bundles {
    fun marshal(bundle: Bundle): ByteArray {
        val parcel = Parcel.obtain()
        try { parcel.writeBundle(bundle); return parcel.marshall() }
        finally { parcel.recycle() }
    }

    fun unmarshal(bytes: ByteArray): Bundle {
        val parcel = Parcel.obtain()
        try {
            parcel.unmarshall(bytes, 0, bytes.size)
            parcel.setDataPosition(0)
            return parcel.readBundle(Bundles::class.java.classLoader) ?: Bundle()
        } finally { parcel.recycle() }
    }
}
```

**用 `Bundle` 不用 JSON**：Android 原生序列化，快、类型安全、能带 `byte[]` / `String[]`。

---

## 三、客户端：`RootProcess.kt`

### 3.1 交换一帧

```kotlin
fun exchange(request: ByteArray, timeoutMs: Long): ByteArray = bounded(timeoutMs) {
    if (!synced) {
        if (!Frames.syncToMagic(process.inputStream)) throw IOException("rootStartFailed")
        synced = true
    }
    Frames.write(process.outputStream, request)
    Frames.read(process.inputStream) ?: throw IOException("rootDisconnected")
}
```

### 3.2 超时包装

```kotlin
private fun <T> bounded(timeoutMs: Long, action: () -> T): T {
    if (closed.get()) throw IOException("rootDisconnected")
    val task = io.submit(Callable { action() })
    try {
        return task.get(timeoutMs.coerceAtLeast(1), TimeUnit.MILLISECONDS)
    } catch (_: TimeoutException) {
        task.cancel(true); close(); throw IOException("rootTimeout")
    } catch (_: InterruptedException) {
        task.cancel(true); close(); Thread.currentThread().interrupt()
        throw IOException("rootCancelled")
    } catch (_: Exception) {
        close(); throw IOException("rootStartFailed")
    }
}
```

**注意**：超时后**直接 `close()`**。因为只读了半个帧，流已经错位，必须整条重建。

### 3.3 stderr 必须抽干（关键）

```kotlin
init {
    // su and the manager write here too (authorization prompts included): drain it so the
    // pipe never fills, keep nothing.
    thread(isDaemon = true, name = "dsh-root-stderr") {
        runCatching {
            val buffer = ByteArray(4096)
            while (process.errorStream.read(buffer) >= 0) { }
        }
    }
}
```

**为什么必须**：管道缓冲区有上限（Linux 通常 64KB）。stderr 没人读，写满后：
1. 子进程 `write(2, ...)` 阻塞
2. 子进程卡死，不再响应请求
3. 整条通道失效

这是**必须遵守的规则**，不是优化。

### 3.4 关闭不能在自己线程做

```kotlin
override fun close() {
    val current = synchronized(muxGuard) {
        if (!closed.compareAndSet(false, true)) return
        mux
    }
    current?.close()
    io.shutdownNow()
    // Closing a pipe another thread reads can block, so not on the caller's thread. Our
    // server also exits on stdin EOF; killing su revokes nothing at the manager.
    thread(isDaemon = true, name = "dsh-root-close") {
        runCatching { process.destroyForcibly() }
        runCatching { process.outputStream.close() }
        runCatching { process.inputStream.close() }
        runCatching { process.errorStream.close() }
    }
}
```

**为什么**：关闭一个「另一线程正在 read」的管道会**阻塞**。在自己线程做会死锁。

---

## 四、握手：`RootStarter.kt`

### 4.1 完整流程（源码节选）

```kotlin
fun start(mayStart: () -> Boolean = { true }): PrivilegedChannel? = synchronized(startLock) start@{
    discardDead()

    // 1. 闸门：用户此刻是否允许
    val ticket = synchronized(guard) {
        channel?.let { return@start if (mayStart()) it else null }
        (state.beginIfAllowed(mayStart) ?: return@start null).also { pendingAllowed = mayStart }
    }
    onChanged()
    val stillAccepted = synchronized(guard) {
        if (!state.current(ticket) || !mayStart()) {
            if (state.current(ticket)) { pendingAllowed = null; state.disconnect() }
            false
        } else true
    }
    if (!stillAccepted) { onChanged(); return@start null }

    // 2. 起进程
    val info = context.applicationInfo
    val process = try {
        RootProcess.launch(RootCommands.appProcess(info.sourceDir,
                          info.splitSourceDirs?.toList().orEmpty()))
    } catch (error: Exception) {
        synchronized(guard) { if (state.current(ticket)) {
            pendingAllowed = null; state.finish(ticket, reason(error)) } }
        onChanged(); return@start null
    }

    // 3. PROBE
    val probe = Bundles.unmarshal(process.exchange(Bundles.marshal(Bundle().apply {
        putString(Proto.OP, Proto.OP_PROBE)
    }), remaining()))

    // 4. 校验 + 协商多路复用
    when {
        !probe.getBoolean(Proto.OK) -> "rootStartFailed"
        !RootProbe.accepted(true, probe.getInt(Proto.UID, -1),
                            probe.getString("revision"), Proto.REVISION) -> "rootIdentityMismatch"
        else -> {
            negotiated = MuxProtocol.peer(probe)
            negotiated?.let { peer ->
                val ack = Bundles.unmarshal(process.exchange(
                    Bundles.marshal(MuxProtocol.optIn(peer)), remaining()))
                MuxProtocol.acknowledge(ack, peer)
            }
            backgroundLimit = backgroundRequestLimit(probe.get(Proto.OK), negotiated != null)
            null
        }
    }
}
```

### 4.2 握手四步

| 步 | 动作 | 失败处理 |
|---|---|---|
| 1 | `mayStart()` 闸门 | 用户关了 root 就不起进程 |
| 2 | `RootProcess.launch(su -c ...)` | `rootStartFailed` |
| 3 | 发 `OP_PROBE`，收对端信息 | `rootStartFailed` |
| 4 | 校验 `uid==0` + `revision` 匹配 | `rootIdentityMismatch` |
| 5 | （可选）`MuxProtocol` 协商 | `identityChanged` |

### 4.3 版本校验

```kotlin
const val REVISION = "dsh-vdisplay-4"

// A running service whose revision differs is refused at connect and replaced (see the starters).
```

**版本不符直接拒绝并替换**，不做兼容猜测。

---

## 五、多路复用：一条管道跑并发请求

单条管道天然是串行的。要并发就得给每个请求编号，响应按编号分派。

### 5.1 信封格式（`MuxProtocol.kt`）

```kotlin
private val header = setOf(Proto.REQUEST_MUX_VERSION, Proto.PEER_INSTANCE, Proto.REQUEST_ID)
private val reserved = header + Proto.MAX_IN_FLIGHT

fun wrap(value: Bundle, peer: String, id: Long): Bundle = Bundle(value).apply {
    putInt(Proto.REQUEST_MUX_VERSION, 1)
    putString(Proto.PEER_INSTANCE, peer)
    putLong(Proto.REQUEST_ID, id)
}
```

**三个信头字段**：
- `requestMuxVersion = 1`
- `peerInstance = <UUID>`
- `requestId = <单调递增 Long>`

### 5.2 会话状态（`FramedMuxSession.kt`）

```kotlin
private val pending = mutableMapOf<Long, CompletableFuture<R>>()
private var nextId = 1L

fun exchange(encode: (Long) -> ByteArray): R {
    val future = CompletableFuture<R>()
    val timedOut = AtomicBoolean(false)
    val timer = try {
        synchronized(lock) {
            if (closed || nextId == Long.MAX_VALUE) throw IOException("deviceUnavailable")
            check(pending.size < 3)                    // 并发上限 3
            val id = nextId++
            pending[id] = future
            writer.execute {
                try {
                    synchronized(lock) { if (closed) return@execute }
                    Frames.write(output, encode(id))
                } catch (_: Throwable) { close() }
            }
            deadlines?.schedule({ retire(id) { timedOut.set(true) } },
                                checkNotNull(deadlineMs), TimeUnit.MILLISECONDS)
        }
    } catch (e: Throwable) { close(); throw e }
    ...
}
```

### 5.3 读线程分派

```kotlin
private fun readReplies() {
    try {
        while (true) {
            val reply = decode(Frames.read(input) ?: throw IOException("deviceUnavailable"))
            val future = synchronized(lock) {
                if (closed) return
                pending.remove(reply.id) ?: throw IOException("identityChanged")
            }
            future.complete(reply.value)
        }
    } catch (_: Throwable) { close() }
}
```

### 5.4 三个并发限制

| 限制 | 值 | 在哪 |
|---|---|---|
| 最大在途请求 | **3** | `check(pending.size < 3)` |
| 写线程队列 | **3** | `ArrayBlockingQueue<Runnable>(3)` |
| 单请求截止 | **30 秒** | `REQUEST_DEADLINE_MS = 30_000L` |

---

## 六、root 侧程序：`PrivilegedDisplayEntry.kt`

### 6.1 入口 main

```kotlin
object PrivilegedDisplayMain {
    @JvmStatic
    @SuppressLint("PrivateApi")
    fun main(args: Array<String>) {
        // ActivityThread.systemMain() constructs Handlers, so prepare before systemContext().
        if (Looper.myLooper() == null) Looper.prepareMainLooper()
        val context = systemContext()
        val core = PrivilegedDisplayHost(context)

        System.err.println("DSH_VDISPLAY_READY uid=${Process.myUid()} rev=${Proto.REVISION}")
        System.err.flush()

        val worker = Thread({ serve(core) }, "dsh-vdisplay")
        worker.isDaemon = true
        worker.start()
        runCatching { Looper.loop() }
        runCatching { core.handle(Bundle().apply { putString(Proto.OP, Proto.OP_DESTROY) }) }
    }
```

**注意**：就绪信号走 **stderr**（`DSH_VDISPLAY_READY uid=0 rev=...`），不走 stdout —— 因为 stdout 是协议通道，不能污染。

### 6.2 拿 Context（反射）

```kotlin
@SuppressLint("PrivateApi")
private fun systemContext(): Context {
    val activityThread = Class.forName("android.app.ActivityThread")
    val thread = activityThread.getMethod("systemMain").invoke(null)
    return activityThread.getMethod("getSystemContext").invoke(thread) as Context
}
```

`app_process` 起的进程没有正常 App 生命周期，得用反射拿系统 Context。

### 6.3 服务循环

```kotlin
private fun serve(core: PrivilegedDisplayHost) {
    val input = System.`in`
    // PrintStream swallows write failures; frames must fail on the original stdout FD.
    val output = java.io.FileOutputStream(java.io.FileDescriptor.out)
    try {
        synchronized(output) { output.write(Frames.MAGIC); output.flush() }
        var businessSeen = false
        while (true) {
            val frame = Frames.read(input) ?: break
            val request = Bundles.unmarshal(frame)
            // ... 处理 / 分流到 mux
            synchronized(output) { Frames.write(output, Bundles.marshal(response)) }
            if (request.getString(Proto.OP) == Proto.OP_DESTROY &&
                (response.get(Proto.OP) as? Boolean) == true) break
        }
    } catch (_: Throwable) {
        // stream closed or malformed: fall through to exit
    } finally {
        runCatching { core.handle(Bundle().apply { putString(Proto.OP, Proto.OP_DESTROY) }) }
        runCatching { Looper.getMainLooper()?.quitSafely() }
        Process.killProcess(Process.myPid())
    }
}
```

**关键细节**：

```kotlin
// PrintStream swallows write failures; frames must fail on the original stdout FD.
val output = java.io.FileOutputStream(java.io.FileDescriptor.out)
```

**不用 `System.out`** —— `PrintStream` 会吞掉写失败，协议帧必须能感知错误。直接用 `FileDescriptor.out`。

---

## 七、常驻：明确不做

### 7.1 `PrivilegedKeepJob.kt` 注释原文

> One boot opportunity, not a periodic service or an authorization bypass: it only asks the
> keeper to restore what the person chose to keep. A stopped job's late [jobFinished] is ignored.

### 7.2 实际做什么

```kotlin
class PrivilegedKeepJob : JobService() {
    override fun onStartJob(params: JobParameters): Boolean {
        Thread({
            try {
                if (wanted(applicationContext) != "off") {
                    A11yKeeper.check(applicationContext)
                    BackgroundControl.get(applicationContext).restoreKeptChannel()?.get()
                }
            } catch (_: Exception) {
                // The keeper reports the observed failure in status, never raw process output.
            } finally {
                jobFinished(params, false)
            }
        }, "dsh-privileged-boot").apply { isDaemon = true }.start()
        return true
    }

    // No retry: the next foreground, task or channel event restores again.
    override fun onStopJob(params: JobParameters): Boolean = false
}
```

### 7.3 触发时机

```kotlin
class Receiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED ||
            intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) schedule(context)
    }
}
```

### 7.4 明确不做

| ❌ 不做 | 原因 |
|---|---|
| 周期任务 | 不是 `setPeriodic` |
| 授权绕过 | 只在用户开过「保持」时恢复 |
| 重试 | `onStopJob` 返回 `false`，不重试 |
| 裸露进程输出 | 失败只在 status 报观察到的结果 |

**设计哲学：root 进程跟着 App 会话走，App 没了就没了，下次用之前重新 `su`。**

---

## 八、三态选择（`PrivilegedKeepState.kt`）

```kotlin
internal class PrivilegedKeepState(savedMode: String, phoneEnabled: Boolean, supported: Boolean) {
    data class Ticket(val generation: Long, val mode: String)
    private data class Selection(val generation: Long, val mode: String,
                                 val kept: String, val saved: Boolean) {
        val active: Boolean get() = saved && kept != "off" && kept == mode
    }
    private val restored = savedMode.takeIf { it in MODES && phoneEnabled && supported } ?: "off"
    @Volatile private var selection = Selection(0, restored, restored, true)
    ...
}
```

| 概念 | 含义 |
|---|---|
| `mode` | 本次任务选的传输方式 |
| `kept` | 用户选择「要保留」的方式 |
| `saved` | 是否已持久化 |
| `active` | 三者一致才算生效 |
| `generation` | 版本号，防并发竞态 |
| `Ticket` | 无锁快照，给闸门用 |

---

## 九、和我们的方案对比

| 维度 | DSH-Go 官方 | 我们 rootd_keeper | 谁更好 |
|---|---|---|---|
| 起 root | `su -c app_process` | KSU 模块 + init 服务 | 官方简单 / 我们稳 |
| 通信 | 进程 stdin/stdout 二进制帧 | 文件队列 `req/` `res/` | 官方低延迟 / 我们跨进程 |
| 协议 | Bundle + 4字节长度帧 | JSON + base64 | 官方更高效 |
| 序列化 | Parcel（原生） | JSON（文本） | 官方快，我们好调试 |
| 常驻 | ❌ 跟 App 会话 | ✅ init 托管 | 我们强 |
| **跨进程** | ❌ 只有当前 App | ✅ **主体/分身都能用** | **我们强** |
| 首次延迟 | 秒级（等 su 授权 + JVM 启动） | 已就绪，直接投递 | 我们快 |
| 单次延迟 | 毫秒级（管道往返） | 0~2000ms（轮询） | 官方快 |
| 授权 | 每次 `su`（除非「保持」） | 一次刷机永久 | 我们省事 |
| 并发 | 3 路多路复用 | 每实例配额 1（最多 4） | 官方强 |
| 安全边界 | 只接受固定 verb 集 | 接受任意 shell | 官方严 |
| 代码量 | ~197KB（16 文件） | ~120KB（13 文件） | 相近 |

### 根本区别

> 官方面向**单实例、同一 App 会话**。
> 主体和分身是两个独立的 App 进程，**不能共享一条 `su` 管道**，
> 所以我们必须走文件系统这种跨进程媒介。
>
> **问题不同，方案不能照搬。**

---

## 十、能被我们直接借鉴的四条

### 1. 版本校验（可以马上加）

官方在 `instance.json` 里校验 `revision`，不符就拒绝。
我们可以同样的思路校验 `instance.json` 里的 `version` 字段，防止新旧守护混跑。

### 2. 可感知的写失败

```kotlin
// PrintStream swallows write failures; frames must fail on the original stdout FD.
val output = java.io.FileOutputStream(java.io.FileDescriptor.out)
```

我们写结果文件时，`> /dev/null 2>&1` 这类写法会吞掉失败。**写关键文件必须检查返回值。**

### 3. 抽干输出管道

任何 `Process` 只要有 stderr，就必须有线程抽干。我们有 `( ... ) </dev/null >/dev/null 2>&1 &` 这种写法，
虽然重定向到 /dev/null 也是一种抽干，但要意识到**如果没有重定向就要显式读**。

### 4. 超时后整条重建

我们的 `rootc.py` 超时后只 `os.unlink(req)` 撤回请求，但如果守护已经取走并写了一半结果，
状态可能不一致。官方的做法是「超时即关闭整条通道」。**我们至少该在超时后强制重扫一次。**

---

## 十一、文件索引

原始源码（MIT 许可）在本目录 `参考源码-DSHGo官方/`：

```
FramedMuxServer.kt          2,282 B
FramedMuxSession.kt         4,364 B
MuxProtocol.kt              3,266 B
PrivilegedActionGate.kt       431 B
PrivilegedChannel.kt        5,448 B
PrivilegedCommands.kt         961 B
PrivilegedDisplayCore.kt  122,486 B   ← 真正干活的部分
PrivilegedDisplayEntry.kt   7,368 B
PrivilegedDisplayHost.kt    6,678 B
PrivilegedKeepJob.kt        2,906 B
PrivilegedKeepState.kt      4,563 B
PrivilegedPathPolicy.kt     2,286 B
PrivilegedProtocol.kt      18,870 B
RootProcess.kt              3,883 B
RootStarter.kt              9,236 B
RootStatus.kt               2,021 B
─────────────────────────────────
合计                      197,142 B
```

**注意**：`PrivilegedDisplayCore.kt` 有 122KB，占了全部代码的 62%。那是业务逻辑（屏幕控制、导航、输入等），
和「root 通道怎么建」无关。通道本身只有约 75KB。
