# @momenttttt/pi-zcode-memory

让 pi 与 ZCode 共用同一份项目记忆。

- 三个工具：`memory_list`、`memory_read`、`memory_write`
- 会话开始时只把 `MEMORY.md` 索引注入一次（正文永不自动注入，按需读）
- 目录算法与文件格式逐条对齐 ZCode，两边读写同一批文件

## 安装

```bash
pi install npm:@momenttttt/pi-zcode-memory
```

> 本包尚在实现中，README 与「设计取舍」一节随实现补齐。

## License

MIT
