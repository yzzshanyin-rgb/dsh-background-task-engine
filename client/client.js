/**
 * dsh-background-task-engine — 浏览器半（配置卡片）
 *
 * 在「插件」页面给本插件挂一张可编辑的配置卡片，读写 8 个数值设置：
 * 任务上限、步骤上限、并发上限、超时、心跳判定、历史保留、摘要长度。
 *
 * ## 为什么配置能「立即生效」
 *
 * 服务端 `Config` 的每个字段都声明为 volatile（见 src/config.ts）。宿主因此
 * 把配置作为可原地更新的引用交给插件，保存后不需要重启或重新加载插件；这张
 * 卡片只是把用户输入写回 profile 的那一层。
 *
 * ## 契约
 *
 * `{ inject: ['slots'], apply(ctx) }`。工厂函数无副作用，样式在 apply 内通过
 * `ctx.effect` 安装，插件卸载时一并移除。React 来自宿主的模块表，不引入其它
 * Harness 客户端包。
 *
 * ## 命名空间为什么有两个常量
 *
 * 插槽 key 用**包名**（插件管理器按 `pkg.name` 给 `plugins.bundle.config` 分
 * 组）；配置表单的 namespace 用 **profile 行 id**（dsh-settings 的 describe()
 * 以 `entry.options.id` 作为 ns）。本插件的行 id 来自自己的 cordis.patch.yml，
 * 是 `background-task-engine`，与包名不同，两者不能混用。
 */
window.__ModuleLoader__.load({
  id: 'dsh-background-task-engine',
  factory(require) {
    var React = require('react')
    var h = React.createElement

    /** 插件管理器为 bundle 配置区使用的 key：必须是包名。 */
    var PACKAGE_NAME = 'dsh-background-task-engine'
    /** dsh-settings 的表单 namespace：profile 行 id，与 cordis.patch.yml 一致。 */
    var ROW_IDS = ['background-task-engine', PACKAGE_NAME]

    /** 字段元数据，与服务端 src/config.ts 的 CONFIG_LIMITS 一一对应。 */
    var FIELDS = [
      {
        key: 'maxTasksPerOwner',
        label: '会话任务上限',
        hint: '每个会话可保留的未归档任务数',
        min: 1,
        max: 1000,
        fallback: 100
      },
      {
        key: 'maxStepsPerTask',
        label: '单任务步骤上限',
        hint: 'V1.0 为线性任务，固定 1–10',
        min: 1,
        max: 10,
        fallback: 10
      },
      {
        key: 'maxActiveRunsPerOwner',
        label: '会话并发运行上限',
        hint: '同时排队/运行的执行数',
        min: 1,
        max: 20,
        fallback: 3
      },
      {
        key: 'maxParallelRunsPerTask',
        label: '单任务并行上限',
        hint: 'V1.0 固定为 1，避免重复副作用',
        min: 1,
        max: 1,
        fallback: 1
      },
      {
        key: 'defaultTimeoutMinutes',
        label: '运行默认超时（分钟）',
        hint: '超时只标记待核验，不自动重启',
        min: 1,
        max: 1440,
        fallback: 60
      },
      {
        key: 'staleRunAfterMinutes',
        label: '心跳失效判定（分钟）',
        hint: '启动扫描超过此时长的运行标为中断',
        min: 1,
        max: 1440,
        fallback: 30
      },
      {
        key: 'historyRetentionDays',
        label: '历史保留（天）',
        hint: '只清理终态运行，不删模板与活动运行',
        min: 1,
        max: 3650,
        fallback: 90
      },
      {
        key: 'maxSummaryChars',
        label: '摘要长度上限',
        hint: '超长截断，保留文件与 Session 引用',
        min: 100,
        max: 10000,
        fallback: 2000
      }
    ]

    var CSS = [
      '.dbte-card{display:flex;flex-direction:column;gap:14px;color:inherit;font-size:13px;line-height:1.5}',
      '.dbte-head{display:flex;flex-direction:column;gap:2px}',
      '.dbte-title{font-size:14px;font-weight:600;letter-spacing:.01em}',
      '.dbte-sub{opacity:.62;font-size:12px}',
      '.dbte-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 16px}',
      '@media (max-width:720px){.dbte-grid{grid-template-columns:minmax(0,1fr)}}',
      '.dbte-field{display:flex;flex-direction:column;gap:5px;min-width:0}',
      '.dbte-label{font-weight:500}',
      '.dbte-hint{opacity:.6;font-size:11.5px}',
      '.dbte-row{display:flex;align-items:center;gap:8px}',
      '.dbte-input{width:100%;min-width:0;box-sizing:border-box;padding:6px 9px;border-radius:8px;border:1px solid rgba(127,127,127,.34);background:rgba(127,127,127,.07);color:inherit;font:inherit;font-variant-numeric:tabular-nums}',
      '.dbte-input:focus{outline:2px solid rgba(84,150,255,.45);outline-offset:1px;border-color:rgba(84,150,255,.55)}',
      '.dbte-input:disabled{opacity:.5;cursor:not-allowed}',
      '.dbte-reset{flex:none;padding:5px 9px;border-radius:8px;border:1px solid rgba(127,127,127,.3);background:transparent;color:inherit;font:inherit;font-size:12px;opacity:.72;cursor:pointer}',
      '.dbte-reset:hover:not(:disabled){opacity:1;border-color:rgba(127,127,127,.5)}',
      '.dbte-reset:disabled{opacity:.35;cursor:not-allowed}',
      '.dbte-foot{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding-top:2px}',
      '.dbte-save{padding:6px 16px;border-radius:8px;border:1px solid transparent;background:rgba(84,150,255,.16);color:inherit;font:inherit;font-weight:500;cursor:pointer}',
      '.dbte-save:hover:not(:disabled){background:rgba(84,150,255,.26)}',
      '.dbte-save:disabled{opacity:.45;cursor:not-allowed}',
      '.dbte-note{font-size:12px;opacity:.7}',
      '.dbte-note[data-kind="error"]{color:#d9534f;opacity:.95}',
      '.dbte-note[data-kind="ok"]{color:#2e9e5b;opacity:.95}',
      '.dbte-banner{padding:10px 12px;border-radius:9px;border:1px solid rgba(217,83,79,.35);background:rgba(217,83,79,.08);font-size:12.5px}'
    ].join('')

    /** 订阅表单控制器（ConfigFormController），返回最新快照。 */
    function useFormState(form) {
      var pair = React.useState(function () {
        return form.getSnapshot()
      })
      var state = pair[0]
      var setState = pair[1]
      React.useEffect(
        function () {
          setState(form.getSnapshot())
          var unsubscribe = form.subscribe(function () {
            setState(form.getSnapshot())
          })
          return unsubscribe
        },
        [form],
      )
      return state
    }

    /** 用快照里的值重建草稿，草稿只存字符串，便于输入框直接编辑。 */
    function draftOf(value) {
      var draft = {}
      for (var i = 0; i < FIELDS.length; i++) {
        var field = FIELDS[i]
        var current = value !== null && typeof value === 'object' ? value[field.key] : undefined
        var usable = typeof current === 'number' && isFinite(current) ? current : field.fallback
        draft[field.key] = String(usable)
      }
      return draft
    }

    /** 校验一行输入，返回错误文本或 null。 */
    function checkField(field, raw) {
      var text = String(raw === undefined ? '' : raw).trim()
      if (text === '') return field.label + ' 不能为空'
      var value = Number(text)
      if (!isFinite(value) || Math.floor(value) !== value) return field.label + ' 必须是整数'
      if (value < field.min || value > field.max) {
        return field.label + ' 需在 ' + field.min + '–' + field.max + ' 之间'
      }
      return null
    }

    /**
     * 配置卡片的挂载点。
     *
     * `view` 的判定必须在这一层做：卡片本体一进来就调用 hooks，若在 hooks 之前
     * 提前 return，插槽从 page 切到 summary 时 hook 顺序会变，React 会报错。
     */
    function ConfigCard(props) {
      if (props !== undefined && props !== null && props.view === 'summary') return null
      return h(ConfigCardForm, props)
    }

    /** 配置卡片本体：字段输入 + 保存 / 逐项恢复默认。 */
    function ConfigCardForm(props) {
      var form = props.form
      var snapshot = useFormState(form)

      var draftPair = React.useState(null)
      var draft = draftPair[0]
      var setDraft = draftPair[1]

      var busyPair = React.useState(false)
      var busy = busyPair[0]
      var setBusy = busyPair[1]

      var noticePair = React.useState(null)
      var notice = noticePair[0]
      var setNotice = noticePair[1]

      var ready = snapshot.status === 'ready'
      var writable = ready && snapshot.writable !== false

      React.useEffect(
        function () {
          if (!ready) return
          setDraft(draftOf(snapshot.value))
          setNotice(null)
        },
        [ready, snapshot.revision],
      )

      function onChange(key, next) {
        setDraft(function (previous) {
          var merged = {}
          for (var name in previous) merged[name] = previous[name]
          merged[key] = next
          return merged
        })
        setNotice(null)
      }

      function save() {
        if (busy || !writable || draft === null) return
        var ops = []
        for (var i = 0; i < FIELDS.length; i++) {
          var field = FIELDS[i]
          var problem = checkField(field, draft[field.key])
          if (problem !== null) {
            setNotice({ kind: 'error', text: problem })
            return
          }
          var next = Number(String(draft[field.key]).trim())
          var current = snapshot.value !== null && typeof snapshot.value === 'object' ? snapshot.value[field.key] : undefined
          if (Number(current) !== next) ops.push({ op: 'set', path: [field.key], value: next })
        }
        if (ops.length === 0) {
          setNotice({ kind: 'info', text: '没有需要保存的修改' })
          return
        }
        setBusy(true)
        setNotice(null)
        Promise.resolve(form.mutate(ops, snapshot.revision)).then(
          function (saved) {
            setBusy(false)
            setNotice(
              saved
                ? { kind: 'ok', text: '已保存并立即生效' }
                : { kind: 'error', text: '保存失败：配置已在别处变更，已重新读取，请重试' },
            )
          },
          function (error) {
            setBusy(false)
            setNotice({
              kind: 'error',
              text: '保存失败：' + (error && error.message ? error.message : String(error)),
            })
          },
        )
      }

      function reset(key) {
        if (busy || !writable) return
        setBusy(true)
        setNotice(null)
        Promise.resolve(form.unset(key)).then(
          function (saved) {
            setBusy(false)
            setNotice(saved ? { kind: 'ok', text: '已恢复默认值' } : { kind: 'error', text: '恢复失败，请重试' })
          },
          function (error) {
            setBusy(false)
            setNotice({
              kind: 'error',
              text: '恢复失败：' + (error && error.message ? error.message : String(error)),
            })
          },
        )
      }

      var children = []

      children.push(
        h(
          'div',
          { className: 'dbte-head', key: 'head' },
          h('div', { className: 'dbte-title' }, '后台任务引擎配置'),
          h(
            'div',
            { className: 'dbte-sub' },
            '数值保存后立即生效，无需重启；越界值会被拒绝，不会被悄悄截断。',
          ),
        ),
      )

      if (snapshot.status === 'loading') {
        children.push(h('div', { className: 'dbte-note', key: 'loading' }, '正在读取配置…'))
      } else if (snapshot.status === 'unavailable') {
        children.push(
          h(
            'div',
            { className: 'dbte-banner', key: 'unavailable' },
            '宿主尚未提供本插件的配置项。请确认插件已启用并完成加载；若刚安装，切换到其他页面再回来即可。',
          ),
        )
      }

      if (ready && draft !== null) {
        var cells = []
        for (var i = 0; i < FIELDS.length; i++) {
          var field = FIELDS[i]
          var value = draft[field.key]
          var disabled = !writable || busy
          cells.push(
            h(
              'label',
              { className: 'dbte-field', key: field.key },
              h('span', { className: 'dbte-label' }, field.label),
              h('span', { className: 'dbte-hint' }, field.hint + '（' + field.min + '–' + field.max + '）'),
              h(
                'span',
                { className: 'dbte-row' },
                h('input', {
                  className: 'dbte-input',
                  type: 'number',
                  inputMode: 'numeric',
                  min: field.min,
                  max: field.max,
                  step: 1,
                  value: value,
                  disabled: disabled,
                  onChange: function (field) {
                    return function (event) {
                      onChange(field.key, event.target.value)
                    }
                  }(field),
                }),
                h(
                  'button',
                  {
                    className: 'dbte-reset',
                    type: 'button',
                    disabled: disabled,
                    title: '恢复默认值',
                    onClick: function (field) {
                      return function () {
                        reset(field.key)
                      }
                    }(field),
                  },
                  '默认',
                ),
              ),
            ),
          )
        }
        children.push(h('div', { className: 'dbte-grid', key: 'grid' }, cells))

        var foot = [
          h(
            'button',
            { className: 'dbte-save', type: 'button', key: 'save', disabled: !writable || busy, onClick: save },
            busy ? '保存中…' : '保存',
          ),
        ]
        if (notice !== null) {
          foot.push(
            h('span', { className: 'dbte-note', key: 'note', 'data-kind': notice.kind, role: 'status' }, notice.text),
          )
        } else if (!writable) {
          foot.push(h('span', { className: 'dbte-note', key: 'ro' }, '当前为只读（宿主未开放写入）。'))
        }
        children.push(h('div', { className: 'dbte-foot', key: 'foot' }, foot))
      }

      return h('div', { className: 'dbte-card', 'data-dsh-background-task-engine': '' }, children)
    }


    // ======================================================================
    // 任务看板（PRD §6）
    //
    // 在输入框下方挂一个「任务」入口，展开后是本 Session 的任务列表、任务
    // 详情与运行时间线，并提供暂停/恢复/归档/恢复运行。
    //
    // 数据一律来自宿主路由（src/services/http-routes.ts），页面不做本地计算，
    // 也不缓存状态——服务端返回什么就显示什么。写操作同样回到服务端，遵循
    // 与工具完全一致的权限与状态校验。
    // ======================================================================

    /** 看板路由前缀，与服务端 ROUTE_PREFIX 保持一致。 */
    var API_PREFIX = '/dsh-background-task/api'
    /** 手动填写的会话 id 存在这里，用于宿主插槽拿不到会话时兜底。 */
    var SESSION_STORAGE_KEY = 'dsh-background-task-engine:session'

    var BOARD_CSS = [
      '.dbte-board{font-size:12px;line-height:1.5;color:inherit}',
      '.dbte-chip{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;',
      'border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;font:inherit;cursor:pointer}',
      '.dbte-chip:hover{background:rgba(127,127,127,.12)}',
      '.dbte-chip[data-active="true"]{border-color:rgba(60,160,110,.75)}',
      '.dbte-panel{margin-top:8px;border:1px solid rgba(127,127,127,.3);border-radius:12px;padding:10px 12px;',
      'background:rgba(127,127,127,.06);max-height:52vh;overflow:auto}',
      '.dbte-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px}',
      '.dbte-head h4{margin:0;font-size:13px;font-weight:600}',
      '.dbte-spacer{flex:1 1 auto}',
      '.dbte-btn{border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;font:inherit;',
      'cursor:pointer;padding:2px 8px;border-radius:8px}',
      '.dbte-btn:hover{background:rgba(127,127,127,.14)}',
      '.dbte-btn[disabled]{opacity:.45;cursor:not-allowed}',
      '.dbte-input,.dbte-select{border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;',
      'font:inherit;padding:3px 8px;border-radius:8px;min-width:0}',
      '.dbte-row{display:flex;align-items:center;gap:8px;padding:7px 6px;border-top:1px solid rgba(127,127,127,.18)}',
      '.dbte-row:first-child{border-top:0}',
      '.dbte-row[data-clickable="true"]{cursor:pointer;border-radius:8px}',
      '.dbte-row[data-clickable="true"]:hover{background:rgba(127,127,127,.1)}',
      '.dbte-title{font-weight:600;flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dbte-meta{opacity:.7;white-space:nowrap}',
      '.dbte-id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;opacity:.6;font-size:11px}',
      '.dbte-tag{display:inline-block;padding:1px 7px;border-radius:999px;font-size:11px;border:1px solid transparent}',
      '.dbte-tag[data-tone="ok"]{color:#2f9e6b;border-color:rgba(47,158,107,.5)}',
      '.dbte-tag[data-tone="run"]{color:#3b82f6;border-color:rgba(59,130,246,.5)}',
      '.dbte-tag[data-tone="warn"]{color:#c78a1b;border-color:rgba(199,138,27,.5)}',
      '.dbte-tag[data-tone="bad"]{color:#d05252;border-color:rgba(208,82,82,.5)}',
      '.dbte-tag[data-tone="mute"]{opacity:.65;border-color:rgba(127,127,127,.4)}',
      '.dbte-note{opacity:.75}',
      '.dbte-note[data-kind="error"]{color:#d05252;opacity:1}',
      '.dbte-note[data-kind="ok"]{color:#2f9e6b;opacity:1}',
      '.dbte-bar{height:4px;border-radius:999px;background:rgba(127,127,127,.25);overflow:hidden;margin-top:6px}',
      '.dbte-bar > i{display:block;height:100%;background:currentColor;opacity:.65}',
      '.dbte-steps{margin:8px 0 0;padding:0;list-style:none}',
      '.dbte-steps li{display:flex;gap:8px;padding:4px 0;align-items:flex-start}',
      '.dbte-dot{width:7px;height:7px;border-radius:50%;margin-top:5px;flex:0 0 auto;background:currentColor;opacity:.4}',
      '.dbte-dot[data-s="completed"]{color:#2f9e6b;opacity:1}',
      '.dbte-dot[data-s="running"]{color:#3b82f6;opacity:1}',
      '.dbte-dot[data-s="failed"]{color:#d05252;opacity:1}',
      '.dbte-dot[data-s="skipped"]{color:#999;opacity:.7}',
      '.dbte-kv{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;margin:6px 0 0}',
      '.dbte-kv dt{opacity:.65}',
      '.dbte-kv dd{margin:0;word-break:break-word}',
      '.dbte-empty{padding:14px 4px;opacity:.75;text-align:center}',
      '.dbte-error{padding:8px 10px;border-radius:8px;border:1px solid rgba(208,82,82,.45);color:#d05252;margin:6px 0}',
    ].join('')

    /** 拼接看板 API 的绝对地址：同源相对路径，桌面与 Web 两种形态都成立。 */
    function apiUrl(path, params) {
      var base = typeof document === 'undefined' || !document.baseURI ? 'http://localhost/' : document.baseURI
      var url = new URL(API_PREFIX + path, base)
      if (params) {
        for (var key in params) {
          if (!Object.prototype.hasOwnProperty.call(params, key)) continue
          var value = params[key]
          if (value === undefined || value === null || value === '') continue
          url.searchParams.set(key, String(value))
        }
      }
      return url.pathname + url.search
    }

    /** 统一的请求封装：非 2xx 与 {error} 都抛 Error，调用方只处理一种失败。 */
    function requestJson(path, params, body) {
      var init = { headers: { accept: 'application/json' } }
      if (body !== undefined) {
        init.method = 'POST'
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(body)
      }
      return fetch(apiUrl(path, params), init).then(function (response) {
        return response.text().then(function (text) {
          var payload
          try {
            payload = text === '' ? {} : JSON.parse(text)
          } catch (error) {
            payload = {}
          }
          if (!response.ok || (payload && payload.error)) {
            var message = payload && payload.error && payload.error.message ? payload.error.message : '请求失败（' + response.status + '）'
            var failure = new Error(message)
            failure.code = payload && payload.error ? payload.error.code : undefined
            throw failure
          }
          return payload
        })
      })
    }

    function storedSession() {
      try {
        return window.localStorage ? window.localStorage.getItem(SESSION_STORAGE_KEY) || '' : ''
      } catch (error) {
        return ''
      }
    }

    function rememberSession(sessionId) {
      try {
        if (window.localStorage) window.localStorage.setItem(SESSION_STORAGE_KEY, sessionId)
      } catch (error) {
        /* 隐私模式下写不了就算了，人工输入每次都可用 */
      }
    }

    /**
     * 认出「当前对话的会话 id」。
     *
     * 宿主把插槽参数留空（renderSlot 传 {}），所以依次尝试：插槽 props、
     * 启动清单、地址栏、上次手工输入。全都取不到时返回空串，由面板提示用户
     * 粘贴会话 id——宁可显示空态，也不猜一个别人的会话去查数据。
     */
    function detectSessionId(props) {
      var candidates = []
      if (props) {
        candidates.push(props.sessionId, props.session && props.session.id, props.ctx && props.ctx.session && props.ctx.session.id)
      }
      var boot = typeof window === 'undefined' ? undefined : window.__DSH_BOOT__
      if (boot && typeof boot === 'object') {
        candidates.push(boot.sessionId, boot.activeSessionId, boot.session && boot.session.id)
      }
      if (typeof window !== 'undefined' && window.location) {
        try {
          var search = new URLSearchParams(window.location.search)
          candidates.push(search.get('session'), search.get('sessionId'), search.get('s'))
          if (window.location.hash) {
            var hash = new URLSearchParams(window.location.hash.replace(/^#/, ''))
            candidates.push(hash.get('session'), hash.get('sessionId'))
          }
        } catch (error) {
          /* 地址栏不可解析时继续用后面的来源 */
        }
      }
      candidates.push(storedSession())
      for (var i = 0; i < candidates.length; i++) {
        var value = candidates[i]
        if (typeof value === 'string' && value.length >= 4) return value
      }
      return ''
    }

    var TASK_STATUS_LABELS = { active: '活动中', paused: '已暂停', archived: '已归档' }
    var RUN_STATUS_LABELS = {
      queued: '排队中',
      running: '执行中',
      blocked: '待处理',
      succeeded: '已完成',
      failed: '失败',
      interrupted: '已中断',
      skipped: '已跳过',
    }
    var STEP_STATUS_LABELS = {
      pending: '等待执行',
      running: '正在执行',
      completed: '已完成',
      failed: '失败',
      skipped: '已跳过',
    }

    function statusTone(status) {
      if (status === 'succeeded') return 'ok'
      if (status === 'failed') return 'bad'
      if (status === 'interrupted') return 'bad'
      if (status === 'blocked') return 'warn'
      if (status === 'running') return 'run'
      if (status === 'paused') return 'warn'
      return 'mute'
    }

    function healthTone(health) {
      if (health === 'finished') return 'ok'
      if (health === 'normal') return 'run'
      if (health === 'timeout' || health === 'suspected_stale') return 'warn'
      if (health === 'interrupted' || health === 'awaiting_confirmation') return 'bad'
      if (health === 'blocked') return 'warn'
      return 'mute'
    }

    function labelOf(map, value) {
      return map[value] === undefined ? String(value) : map[value]
    }

    /** 短时间：只显示到分钟，避免看板被长 ISO 串撑开。 */
    function shortTime(value) {
      if (typeof value !== 'string' || value.length < 16) return value ? String(value) : '—'
      return value.slice(0, 16).replace('T', ' ')
    }

    /**
     * 读一次服务端数据。
     *
     * 取消用 effect 闭包里的标志位，而不是 useRef 计数：依赖变化时 React 会先
     * 调清理函数，旧请求的结果自然被丢弃，组件本身不需要保存额外状态。
     */
    function useSnapshot(load, deps) {
      var state = React.useState({ phase: 'loading', data: undefined, error: undefined })
      var snapshot = state[0]
      var setSnapshot = state[1]

      React.useEffect(function () {
        var cancelled = false
        setSnapshot(function (previous) {
          return { phase: 'loading', data: previous.data, error: undefined }
        })
        load()
          .then(function (data) {
            if (cancelled) return
            setSnapshot({ phase: 'ready', data: data, error: undefined })
          })
          .catch(function (error) {
            if (cancelled) return
            setSnapshot({ phase: 'error', data: undefined, error: error })
          })
        return function () {
          cancelled = true
        }
      }, deps)

      return [snapshot, function () {
        setSnapshot({ phase: 'loading', data: snapshot.data, error: undefined })
      }]
    }

    function Bar(props) {
      var percent = typeof props.percent === 'number' ? Math.max(0, Math.min(100, props.percent)) : 0
      return h('div', { className: 'dbte-bar' }, h('i', { style: { width: percent + '%' } }))
    }

    function StepList(props) {
      var steps = props.steps || []
      if (steps.length === 0) return h('div', { className: 'dbte-empty' }, '没有步骤记录。')
      return h(
        'ul',
        { className: 'dbte-steps' },
        steps.map(function (step) {
          var children = [
            h('span', { className: 'dbte-dot', 'data-s': step.status, key: 'dot' }),
            h(
              'div',
              { key: 'body', style: { minWidth: 0 } },
              h(
                'div',
                null,
                step.order + '. ' + step.title,
                h('span', { className: 'dbte-meta' }, ' · ' + labelOf(STEP_STATUS_LABELS, step.status)),
                step.required === false ? h('span', { className: 'dbte-meta' }, ' · 可选') : null,
              ),
              step.startedAt || step.finishedAt
                ? h('div', { className: 'dbte-meta' }, shortTime(step.startedAt) + ' → ' + shortTime(step.finishedAt))
                : null,
              step.summary ? h('div', { className: 'dbte-note' }, step.summary) : null,
              step.error && step.error.message
                ? h('div', { className: 'dbte-note', 'data-kind': 'error' }, '失败原因：' + step.error.message)
                : null,
              step.failureCategory ? h('div', { className: 'dbte-meta' }, '类别：' + step.failureCategory) : null,
              step.carryOverFromRunId
                ? h('div', { className: 'dbte-meta' }, '结转自 ' + step.carryOverFromRunId)
                : null,
            ),
          ]
          return h('li', { key: step.stepId }, children)
        }),
      )
    }

    function RunView(props) {
      var session = props.session
      var runId = props.runId
      var loaded = useSnapshot(
        function () {
          return requestJson('/run', { session: session, runId: runId })
        },
        [session, runId, props.reloadToken],
      )
      var snapshot = loaded[0]
      if (snapshot.phase === 'error') {
        return h('div', { className: 'dbte-error' }, snapshot.error.message)
      }
      var data = snapshot.data
      if (!data) return h('div', { className: 'dbte-empty' }, '读取运行详情…')
      var run = data.run

      return h(
        'div',
        null,
        h(
          'div',
          { className: 'dbte-head' },
          h('button', { className: 'dbte-btn', onClick: props.onBack }, '返回'),
          h('h4', null, '运行详情'),
          h('span', { className: 'dbte-tag', 'data-tone': healthTone(run.health) }, run.healthLabel || run.health),
          h('span', { className: 'dbte-spacer' }),
          run.resumable
            ? h(
                'button',
                {
                  className: 'dbte-btn',
                  disabled: props.busy,
                  onClick: function () {
                    props.onResumeRun(run, data.recovery)
                  },
                },
                run.needsUserConfirmation ? '确认并恢复' : '恢复',
              )
            : null,
        ),
        h('div', { className: 'dbte-id' }, run.runId),
        h(
          'div',
          { className: 'dbte-meta' },
          labelOf(RUN_STATUS_LABELS, run.status) +
            ' · ' +
            run.requiredCompleted +
            '/' +
            run.requiredTotal +
            ' 必需步骤 · 触发：' +
            (run.triggerType === 'schedule' ? '定时' : '手动'),
        ),
        h(Bar, { percent: run.progress }),
        run.needsUserConfirmation
          ? h(
              'div',
              { className: 'dbte-note', 'data-kind': 'error' },
              '恢复会重跑可能已产生外部副作用的步骤，需要人工确认后才会执行。',
            )
          : null,
        run.failureCategory || (run.error && run.error.message)
          ? h(
              'div',
              { className: 'dbte-note', 'data-kind': 'error' },
              (run.failureCategory ? '失败类别：' + run.failureCategory + '；' : '') +
                (run.error && run.error.message ? run.error.message : ''),
            )
          : null,
        h(
          'dl',
          { className: 'dbte-kv' },
          h('dt', null, '开始'),
          h('dd', null, shortTime(run.startedAt)),
          h('dt', null, '最近心跳'),
          h('dd', null, run.lastHeartbeatAt ? shortTime(run.lastHeartbeatAt) : '—'),
          h('dt', null, '租约到期'),
          h('dd', null, run.leaseExpiresAt ? shortTime(run.leaseExpiresAt) : '—'),
          h('dt', null, '结束'),
          h('dd', null, run.finishedAt ? shortTime(run.finishedAt) : '—'),
          data.recovery
            ? h('dt', null, '恢复确认')
            : null,
          data.recovery
            ? h(
                'dd',
                null,
                '来自 ' + data.recovery.sourceRunId + '，确认于 ' + shortTime(data.recovery.confirmedAt),
              )
            : null,
          run.resumesRunId ? h('dt', null, '恢复自') : null,
          run.resumesRunId ? h('dd', { className: 'dbte-id' }, run.resumesRunId) : null,
        ),
        run.summary ? h('div', { className: 'dbte-note' }, '结果摘要：' + run.summary) : null,
        h('div', { className: 'dbte-head', style: { marginTop: '10px' } }, h('h4', null, '步骤时间线')),
        h(StepList, { steps: data.steps }),
      )
    }

    function TaskDetail(props) {
      var session = props.session
      var taskId = props.taskId
      var loaded = useSnapshot(
        function () {
          return requestJson('/task', { session: session, taskId: taskId })
        },
        [session, taskId, props.reloadToken],
      )
      var snapshot = loaded[0]
      if (snapshot.phase === 'error') return h('div', { className: 'dbte-error' }, snapshot.error.message)
      var data = snapshot.data
      if (!data) return h('div', { className: 'dbte-empty' }, '读取任务详情…')
      var task = data.task
      var latest = data.runs && data.runs.length > 0 ? data.runs[0] : null

      var actions = []
      if (task.status !== 'archived') {
        actions.push(
          h(
            'button',
            {
              key: 'toggle',
              className: 'dbte-btn',
              disabled: props.busy,
              onClick: function () {
                props.onAction(task, task.status === 'active' ? 'pause' : 'resume')
              },
            },
            task.status === 'active' ? '暂停' : '恢复',
          ),
        )
        actions.push(
          h(
            'button',
            {
              key: 'archive',
              className: 'dbte-btn',
              disabled: props.busy,
              onClick: function () {
                props.onAction(task, 'archive')
              },
            },
            '归档',
          ),
        )
      }

      return h(
        'div',
        null,
        h(
          'div',
          { className: 'dbte-head' },
          h('button', { className: 'dbte-btn', onClick: props.onBack }, '返回'),
          h('h4', null, task.title),
          h(
            'span',
            { className: 'dbte-tag', 'data-tone': statusTone(task.status) },
            labelOf(TASK_STATUS_LABELS, task.status),
          ),
          h('span', { className: 'dbte-spacer' }),
          actions,
        ),
        h('div', { className: 'dbte-id' }, task.taskId + ' · revision ' + task.revision),
        task.description ? h('div', { className: 'dbte-note' }, task.description) : null,
        h(
          'dl',
          { className: 'dbte-kv' },
          h('dt', null, '更新于'),
          h('dd', null, shortTime(task.updatedAt)),
          h('dt', null, '定时'),
          h(
            'dd',
            null,
            data.schedule === null
              ? '未关联'
              : labelOf({ active: '已启用', paused: '已暂停', unlinked: '已解除' }, data.schedule.state) +
                ' · ' +
                (data.schedule.nextRunAt ? shortTime(data.schedule.nextRunAt) : '下次时间未知'),
          ),
          h('dt', null, '步骤'),
          h('dd', null, String(task.steps.length)),
        ),
        h(
          'ul',
          { className: 'dbte-steps' },
          task.steps.map(function (step) {
            return h(
              'li',
              { key: step.stepId },
              h('span', { className: 'dbte-dot' }),
              h(
                'div',
                null,
                step.order + '. ' + step.title,
                step.required === false ? h('span', { className: 'dbte-meta' }, ' · 可选') : null,
                step.retryPolicy ? h('span', { className: 'dbte-meta' }, ' · 恢复策略 ' + step.retryPolicy) : null,
              ),
            )
          }),
        ),
        data.operations && data.operations.length > 0
          ? h(
              'div',
              null,
              h('div', { className: 'dbte-head', style: { marginTop: '10px' } }, h('h4', null, '定时操作记录')),
              data.operations.map(function (op) {
                return h(
                  'div',
                  { className: 'dbte-row', key: op.operationId },
                  h('span', { className: 'dbte-tag', 'data-tone': op.status === 'succeeded' ? 'ok' : op.status === 'failed' ? 'bad' : 'warn' }, op.status),
                  h('span', null, op.action),
                  h('span', { className: 'dbte-spacer' }),
                  h('span', { className: 'dbte-meta' }, shortTime(op.updatedAt)),
                )
              }),
            )
          : null,
        h('div', { className: 'dbte-head', style: { marginTop: '10px' } }, h('h4', null, '最近运行')),
        data.runs.length === 0
          ? h('div', { className: 'dbte-empty' }, '还没有运行记录。')
          : data.runs.map(function (run) {
              return h(
                'div',
                {
                  className: 'dbte-row',
                  key: run.runId,
                  'data-clickable': 'true',
                  onClick: function () {
                    props.onOpenRun(run.runId)
                  },
                },
                h('span', { className: 'dbte-tag', 'data-tone': statusTone(run.status) }, labelOf(RUN_STATUS_LABELS, run.status)),
                h('span', { className: 'dbte-title' }, run.runId),
                h('span', { className: 'dbte-meta' }, shortTime(run.startedAt)),
                h('span', { className: 'dbte-meta' }, run.requiredCompleted + '/' + run.requiredTotal),
              )
            }),
        latest && latest.needsUserConfirmation
          ? h('div', { className: 'dbte-note', 'data-kind': 'error' }, '最近一次运行需要人工确认才能恢复。')
          : null,
      )
    }

    function TaskList(props) {
      var session = props.session
      var filter = React.useState({ status: '', query: '' })
      var current = filter[0]
      var setFilter = filter[1]
      var loaded = useSnapshot(
        function () {
          return requestJson('/tasks', { session: session, status: current.status, query: current.query, limit: 50 })
        },
        [session, current.status, current.query, props.reloadToken],
      )
      var snapshot = loaded[0]

      var rows
      if (snapshot.phase === 'error') {
        rows = h('div', { className: 'dbte-error' }, snapshot.error.message)
      } else if (!snapshot.data) {
        rows = h('div', { className: 'dbte-empty' }, '读取任务列表…')
      } else if (snapshot.data.items.length === 0) {
        rows = h('div', { className: 'dbte-empty' }, '还没有任务。可以让 Agent 调用 task_create 建一个。')
      } else {
        rows = snapshot.data.items.map(function (row) {
          var lastRun = row.lastRun
          return h(
            'div',
            {
              className: 'dbte-row',
              key: row.taskId,
              'data-clickable': 'true',
              onClick: function () {
                props.onOpenTask(row.taskId)
              },
            },
            h(
              'span',
              { className: 'dbte-tag', 'data-tone': statusTone(row.status) },
              labelOf(TASK_STATUS_LABELS, row.status),
            ),
            h('span', { className: 'dbte-title' }, row.title),
            h('span', { className: 'dbte-meta' }, row.trigger === 'schedule' ? '定时' : '手动'),
            lastRun === null
              ? h('span', { className: 'dbte-meta' }, '未运行')
              : h(
                  'span',
                  { className: 'dbte-tag', 'data-tone': statusTone(lastRun.status) },
                  labelOf(RUN_STATUS_LABELS, lastRun.status),
                ),
            h('span', { className: 'dbte-meta' }, shortTime(row.updatedAt)),
          )
        })
      }

      return h(
        'div',
        null,
        h(
          'div',
          { className: 'dbte-head' },
          h('h4', null, '任务'),
          h('span', { className: 'dbte-spacer' }),
          h(
            'select',
            {
              className: 'dbte-select',
              value: current.status,
              onChange: function (event) {
                var next = event.target.value
                setFilter(function (previous) {
                  return { status: next, query: previous.query }
                })
              },
            },
            h('option', { value: '' }, '全部状态'),
            h('option', { value: 'active' }, '活动中'),
            h('option', { value: 'paused' }, '已暂停'),
            h('option', { value: 'archived' }, '已归档'),
          ),
          h('input', {
            className: 'dbte-input',
            placeholder: '按名称搜索',
            value: current.query,
            onChange: function (event) {
              var next = event.target.value
              setFilter(function (previous) {
                return { status: previous.status, query: next }
              })
            },
          }),
          h('button', { className: 'dbte-btn', onClick: loaded[1] }, '刷新'),
        ),
        rows,
      )
    }

    /** 拿不到会话时的人工入口：粘贴一次，之后记在本地。 */
    function SessionPrompt(props) {
      var draft = React.useState('')
      var onChange = draft[1]
      return h(
        'div',
        null,
        h('div', { className: 'dbte-empty' }, '无法自动识别当前会话。请粘贴会话 id（Session ID）后继续。'),
        h(
          'div',
          { className: 'dbte-head' },
          h('input', {
            className: 'dbte-input',
            placeholder: 'sess_…',
            value: draft[0],
            onChange: function (event) {
              onChange(event.target.value)
            },
          }),
          h(
            'button',
            {
              className: 'dbte-btn',
              disabled: draft[0].trim().length < 4,
              onClick: function () {
                props.onSession(draft[0].trim())
              },
            },
            '使用',
          ),
        ),
        h('div', { className: 'dbte-note' }, '只会读取该会话自己的任务；看板不提供会话列表。'),
      )
    }

    function BoardPanel(props) {
      var stack = React.useState({ view: 'list', taskId: undefined, runId: undefined })
      var route = stack[0]
      var setRoute = stack[1]
      var revision = React.useState(0)
      var reloadToken = revision[0]
      var setReloadToken = revision[1]
      var busy = React.useState(false)
      var setBusy = busy[1]
      var notice = React.useState(undefined)
      var setNotice = notice[1]

      function refresh() {
        setReloadToken(function (previous) {
          return previous + 1
        })
      }

      function runAction(task, action) {
        setBusy(true)
        setNotice(undefined)
        requestJson('/action', undefined, {
          session: props.session,
          taskId: task.taskId,
          action: action,
          expectedRevision: task.revision,
        })
          .then(function (result) {
            setNotice({ kind: 'ok', text: '已' + (action === 'pause' ? '暂停' : action === 'resume' ? '恢复' : '归档') + '，revision ' + result.revision })
            refresh()
          })
          .catch(function (error) {
            setNotice({ kind: 'error', text: error.message })
          })
          .then(function () {
            setBusy(false)
          })
      }

      function resumeRun(run, recovery) {
        setBusy(true)
        setNotice(undefined)
        var needsConfirm = run.needsUserConfirmation === true
        var note = needsConfirm
          ? '手动确认：' + (recovery ? '沿用上次确认记录；' : '') + '恢复会重跑未完成步骤。'
          : undefined
        requestJson('/action', undefined, {
          session: props.session,
          taskId: run.taskId,
          runId: run.runId,
          action: 'resume-run',
          confirmation: note,
        })
          .then(function (result) {
            setNotice({ kind: 'ok', text: '已创建恢复运行 ' + result.runId })
            setRoute({ view: 'run', taskId: run.taskId, runId: result.runId })
          })
          .catch(function (error) {
            setNotice({ kind: 'error', text: error.message })
          })
          .then(function () {
            setBusy(false)
          })
      }

      var body
      if (route.view === 'run' && route.runId) {
        body = h(RunView, {
          session: props.session,
          runId: route.runId,
          busy: busy[0],
          reloadToken: reloadToken,
          onBack: function () {
            setRoute({ view: 'detail', taskId: route.taskId, runId: undefined })
          },
          onResumeRun: resumeRun,
        })
      } else if (route.view === 'detail' && route.taskId) {
        body = h(TaskDetail, {
          session: props.session,
          taskId: route.taskId,
          busy: busy[0],
          reloadToken: reloadToken,
          onBack: function () {
            setRoute({ view: 'list', taskId: undefined, runId: undefined })
          },
          onAction: runAction,
          onOpenRun: function (runId) {
            setRoute({ view: 'run', taskId: route.taskId, runId: runId })
          },
        })
      } else {
        body = h(TaskList, {
          session: props.session,
          reloadToken: reloadToken,
          onOpenTask: function (taskId) {
            setRoute({ view: 'detail', taskId: taskId, runId: undefined })
          },
        })
      }

      return h(
        'div',
        { className: 'dbte-board' },
        notice[0]
          ? h('div', { className: 'dbte-note', 'data-kind': notice[0].kind }, notice[0].text)
          : null,
        body,
        h(
          'div',
          { className: 'dbte-head', style: { marginTop: '8px' } },
          h('span', { className: 'dbte-spacer' }),
          h('button', { className: 'dbte-btn', onClick: props.onClose }, '收起'),
        ),
      )
    }

    function BoardDock(props) {
      var open = React.useState(false)
      var isOpen = open[0]
      var setOpen = open[1]
      var session = React.useState(function () {
        return detectSessionId(props)
      })
      var sessionId = session[0]
      var setSessionId = session[1]

      function adopt(value) {
        rememberSession(value)
        setSessionId(value)
      }

      var panel = null
      if (isOpen) {
        panel = h(
          'div',
          { className: 'dbte-panel' },
          sessionId === ''
            ? h(SessionPrompt, { onSession: adopt })
            : h(BoardPanel, {
                session: sessionId,
                onClose: function () {
                  setOpen(false)
                },
              }),
        )
      }

      return h(
        'div',
        { className: 'dbte-board' },
        h(
          'button',
          {
            className: 'dbte-chip',
            'data-active': isOpen ? 'true' : 'false',
            onClick: function () {
              setOpen(!isOpen)
            },
          },
          '📋 任务',
        ),
        panel,
      )
    }

    /** 看板入口的插槽契约与配置卡片一致：只在宿主提供 slots 时注册。 */
    function registerBoard(ctx) {
      ctx.inject(['slots'], function (scoped) {
        if (!scoped.slots || typeof scoped.slots.register !== 'function') return
        scoped.effect(
          function () {
            return scoped.slots.inject('conversation.composer.dock', function () {
              return scoped.slots.register(
                {
                  name: 'conversation.composer.dock',
                  id: 'background-task-board',
                  order: 20,
                },
                BoardDock,
              )
            })
          },
          'dsh-background-task-engine: board dock',
        )
      })
    }

    return {
      name: PACKAGE_NAME,
      inject: ['slots'],
      apply: function apply(ctx) {
        var install = function () {
          if (typeof document === 'undefined') return function () {}
          var el = document.createElement('style')
          el.setAttribute('data-dsh-background-task-engine', '')
          el.textContent = CSS + BOARD_CSS
          document.head.appendChild(el)
          return function () {
            el.remove()
          }
        }
        if (typeof ctx.effect === 'function') ctx.effect(install)
        else install()

        // 配置表单服务由 dsh-client-ui-settings 提供；缺失时整张卡片不注册，
        // 而不是渲染一个点不动的表单。
        ctx.inject(['configForms'], function (scoped) {
          var forms = scoped.configForms
          if (!forms || typeof forms.get !== 'function') return

          var registeredFor = null
          var disposeSlot = null

          /** 从 dsh-settings 的 describe 镜像里挑出本插件自己的命名空间。 */
          function detectNamespace() {
            var mirror = typeof forms.describe === 'function' ? forms.describe() : undefined
            var snapshot = mirror && typeof mirror.getSnapshot === 'function' ? mirror.getSnapshot() : undefined
            var view = snapshot && snapshot.view
            var rows = view && Array.isArray(view.namespaces) ? view.namespaces : []

            var names = []
            for (var i = 0; i < rows.length; i++) {
              if (rows[i] && rows[i].ns !== undefined) names.push(rows[i].ns)
            }
            // 首选 profile 行 id：与 cordis.patch.yml 的 id 一致。
            for (var j = 0; j < ROW_IDS.length; j++) {
              if (names.indexOf(ROW_IDS[j]) >= 0) return ROW_IDS[j]
            }
            // 兜底：按 schema 特征认领。行 id 被用户覆盖（或宿主换了 id 规则）时，
            // 仍能认出属于本插件的配置项，而不是干脆没有卡片。
            for (var k = 0; k < rows.length; k++) {
              var row = rows[k]
              if (!row || row.ns === undefined) continue
              var probe = ''
              try {
                probe = JSON.stringify(row.schema === undefined ? {} : row.schema)
              } catch (error) {
                probe = ''
              }
              if (probe.indexOf('maxTasksPerOwner') >= 0) return row.ns
            }
            return undefined
          }

          function registerOnce() {
            if (registeredFor !== null) return
            var namespace = detectNamespace()
            if (namespace === undefined) return
            registeredFor = namespace
            var form = forms.get(namespace)
            disposeSlot = scoped.slots.inject('plugins.bundle.config', function () {
              return scoped.slots.register(
                {
                  name: 'plugins.bundle.config',
                  key: PACKAGE_NAME,
                  inject: function () {
                    return { form: form }
                  },
                },
                ConfigCard,
              )
            })
          }

          scoped.effect(
            function () {
              var mirror = typeof forms.describe === 'function' ? forms.describe() : undefined
              if (mirror && typeof mirror.ensure === 'function') mirror.ensure()
              var unsubscribe =
                mirror && typeof mirror.subscribe === 'function'
                  ? mirror.subscribe(registerOnce)
                  : function () {}
              registerOnce()
              return function () {
                unsubscribe()
                if (typeof disposeSlot === 'function') disposeSlot()
                disposeSlot = null
                registeredFor = null
              }
            },
            'dsh-background-task-engine: configuration card',
          )
        })

        registerBoard(ctx)
      },
    }
  },
})
