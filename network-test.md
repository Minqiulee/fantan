操作：
给 /api/stream 建连加三段计时（ctx 读 → mutate → 首帧）+ 计数器：重连次数/分钟、建连 p50/p95、pool.waitingCount、sse group.size。
1. 测检测延迟：Chrome DevTools 切 offline 或 iptables -A OUTPUT -p tcp --dport 443 -j DROP 模拟静默断链，记录 connLost 出现耗时。若 >30s 则检测延迟不可控（心跳仅服务端单向 ping；客户端无“最后收到事件时间”判断；无 es.close() 超时兜底）。
2. 拆建连成本：临时给 handleStream 打点。预期 mutate 段占大头。再把“撤销 leftAt”改成只读跳过（test/presence.test.mjs 可验证语义未变），对比恢复时间——若掉一个数量级，则建连即写库存在问题（handleStream → store.mutate（撤销 leftAt）→ withLocalLock 串行 → commitSnapshot 事务）。
3. 验死连接与崩溃：kill -9 客户端进程造半开，观察 group.size 是否单调增长、heapUsed 是否爬升；再对已 destroy() 的 res 执行 write，看进程是否退出。如果退出说明单连接可拖垮进程（全仓库无 res.on('error') / req.socket.on('error') / process.on('uncaughtException')（已全量 grep 确认为空）。写已销毁的 response 会 emit 未监听的 error → 进程退出 → 所有 SSE 同时断）

结论：
1) 检测延迟：你的判断成立，实测比预期更差。​ 静默断链后服务端 >70s 仍未发现（连接一直挂在 sseClients 组里），客户端也一个字节都没再收到。客户端主动 close() 后服务端 58ms 就清组——说明 FIN 链路是通的，缺的只是「谁来判断该关」。三个缺失项全部确认：心跳只单向写、客户端没有「最后收到事件时间」、没有 es.close() 超时兜底。
2) 建连成本：预期「mutate 占大头」在单客户端下不成立。​ 在场玩家重连 p50：ctx 3.7ms、mutate 2.94ms、frame 0.3ms，total 6.9ms。改成只读跳过后 total 6.9→4.4ms（-36%，不是数量级），mutate 精确归零。
但「建连即写库存在问题」这个结论仍然成立，理由不同：单次 2.94ms 不致命，致命的是它进了 withLocalLock 串行队列。一百个客户端同时刷新 = 一百次排队，且其中绝大多数 mutator 直接 skip。真实写事务成本实测 12.8–13.5ms，这个量级一旦排队就是秒级。所以优化点是对的，收益要看并发度，不能看单发 p50。
1) 死连接与崩溃：一半成立，一半是你假设错了。​
kill -9 客户端进程造不出半开——内核会发 RST/FIN。真正的半开要用链路静默，我用可黑洞化的 TCP 代理（停转发 + pause，连接保持 ESTABLISHED）。
半开成立：6 条半开 + 持续广播 60s，connections 始终 12，从不回收。
内存爬升不成立：60s 内 stalled=0、maxPending=0KB、rss 在 56–75MB 之间上下波动（GC 主导）。原因是半开连接的写入先被内核发送缓冲（MB 级）吸收，这轮广播量填不满。所以「死连接吃内存」是累积型的，靠 rss 曲线根本发现不了，必须靠 writableLength 判据——这条已经做了。
「写已销毁的 res 会让进程退出」不成立。最小探针跑四种情形（RST 后写小包 / 写 2MB / 先 end 再 write / destroy 后 write），全部 exit=0：Node 22 的 http server 会替 socket 层吞掉 ECONNRESET。后来对真实服务做同样场景（客户端 RST → 触发广播），/healthz=200、日志无未捕获异常。uncaughtException 缺失仍是风险，但风险性质是「漏网的 error 事件」，不是「已销$$毁 res」。

总结:
**实测结果（黑洞 TCP 代理模拟静默断链）**
- 静默断链后服务端 **>70s 仍未发现**（连接一直挂在组里）；客户端主动 close 后 **58ms** 回收。检测延迟不可控，根因是心跳单向写 + 客户端无空闲判据。
- 在场玩家重连：`mutate` p50 **2.94ms → 0ms**（只读预检），`total` **6.9ms → 4.4ms**（降 36%，不是数量级——ctx 段占大头）。
- 确有 `left_at` 要撤销时两版都在写库，`mutate` 12.8–13.5ms（真实写事务成本）。
- 6 条半开连接 + 持续广播 60s：`connections` 始终 12、`stalled`/`maxPending` 为 0（写入先被内核发送缓冲 MB 级吸收）；`rss` 在 56–75MB 间波动，**没有单调爬升**。
- **反驳原假设**：对已销毁的 `res` 写入不会让进程退出。Node 22 的 http server 会吞 ECONNRESET；四种情形（afterRst/afterRstBig/afterEnd/afterDestroy）探针均 exit=0。真正的隐患是半开连接上无界的 userspace 待发队列。$$