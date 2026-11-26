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

    return {
      name: PACKAGE_NAME,
      inject: ['slots'],
      apply: function apply(ctx) {
        var install = function () {
          if (typeof document === 'undefined') return function () {}
          var el = document.createElement('style')
          el.setAttribute('data-dsh-background-task-engine', '')
          el.textContent = CSS
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
          if (!forms || typeof forms.get !== 'function' || typeof forms.whileServed !== 'function') return

          scoped.effect(
            function () {
              return forms.whileServed(ROW_IDS, function (served) {
                var namespace = ROW_IDS[0]
                for (var i = 0; i < ROW_IDS.length; i++) {
                  if (served !== undefined && typeof served.has === 'function' && served.has(ROW_IDS[i])) {
                    namespace = ROW_IDS[i]
                    break
                  }
                }
                var form = forms.get(namespace)
                return scoped.slots.inject('plugins.bundle.config', function () {
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
              })
            },
            'dsh-background-task-engine: configuration card',
          )
        })
      },
    }
  },
})
