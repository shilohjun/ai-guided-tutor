/**
 * 语音输入 —— 用浏览器自带的 Web Speech API 把说的话变成文字。
 *
 * ============================================================================
 * 为什么是浏览器自带的，而不是接一个识别服务
 * ============================================================================
 * 这条路上没有后端更划算：Web Speech API 是浏览器内置能力，不需要 Key、
 * 不按次计费、音频不出本机浏览器进程（Chrome/Edge 的实际后端在厂商侧）。
 * 对一个"发给别人双击就能看"的 PoC，这是唯一不需要额外凭据的方案。
 *
 * ============================================================================
 * 为什么现在才接（原来那个是桩）
 * ============================================================================
 * `public/index.html` 里原本的 `#micBtn` 是个桩：点一下只把 placeholder 改成
 * 「语音识别未接入，请直接输入文字」，2.6 秒后还原 —— 它连 `SpeechRecognition`
 * 都没碰过。但仓库根目录的设计原型 `v3.html` 里是真实现过的，而且
 * `index.html` 里 `.recording .mic-btn` / `.mic-btn.is-rec` 那套录音态样式
 * 一直留着、没人喂状态。所以这不是"缺能力"，是搬进新界面时被换成了桩。
 *
 * ============================================================================
 * 局限（写清楚，免得当成万能）
 * ============================================================================
 *   · 只有 Chrome / Edge 系可用；Firefox 不支持，Safari 支持得不稳定。
 *   · Chrome 的识别要走厂商的语音服务 —— 国内网络不通时错误码是 `network`，
 *     界面上直接告诉学生"改用文字"，不假装在听。
 *   · 必须 https 或 localhost（麦克风是受限能力）。本地 127.0.0.1 没问题。
 */

/**
 * 把一段识别结果接到已有草稿后面。
 *
 * 为什么接在**末尾**而不是光标处：口述是"接着说"，学生按麦克风时脑子里是
 * "我再补一句"，不是"我要在第三行中间插一句"。接末尾还顺手绕开了
 * "这个框从没被点过、selectionStart 默认是 0"的坑（符号面板那边就得专门处理它）。
 *
 * @param {string} existing 已有草稿
 * @param {string} transcript 这次识别出来的话
 * @returns {string} 拼接后的草稿（没有新内容时原样返回）
 */
export function appendTranscript(existing, transcript) {
  const base = String(existing ?? '');
  const add = String(transcript ?? '').trim();
  if (!add) return base;
  if (!base) return add;
  // 中间留一个空格：口述英文、公式名时不断词；中文多一个空格也不碍读
  return /\s$/.test(base) ? base + add : `${base} ${add}`;
}

/**
 * 错误码 → 学生看得懂的一句话。
 *
 * 不写"识别失败请重试"这种废话：`not-allowed` 和学生自己点停是两件事，
 * 前者要去开权限，后者什么都不用做。
 */
export function errorText(code) {
  switch (String(code || '')) {
    case 'not-allowed':
    case 'service-not-allowed':
      return '麦克风权限没开 —— 地址栏左侧允许麦克风后再说一遍';
    case 'no-speech':
      return '没听到声音，再说一次试试';
    case 'audio-capture':
      return '没找到麦克风，请检查设备';
    case 'network':
      return '语音服务连不上，请直接输入文字';
    case 'aborted':
      return '';
    default:
      return '语音没识别成功，请直接输入文字';
  }
}

/** Chrome / Edge 走 webkit 前缀，规范名是 SpeechRecognition */
export function speechEngine() {
  if (typeof window === 'undefined') return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

/* ==========================================================================
 * 浏览器那一半。Node 里 import 只会拿到上面三个纯函数 ——
 * `test/voice.test.js` 就是这么用的。
 * ======================================================================== */

function init() {
  const Engine = speechEngine();
  /** 同一时刻只允许一路在录 */
  let active = null;

  const pairs = [];
  for (const button of document.querySelectorAll('[data-mic-for]')) {
    const input = document.getElementById(button.getAttribute('data-mic-for'));
    if (input) pairs.push({ button, input });
  }
  if (!pairs.length) return;

  function setRecording(button, on) {
    button.classList.toggle('is-rec', on);
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
    const box = button.closest('.composer');
    if (box) box.classList.toggle('recording', on);
  }

  /** 借 placeholder 说一句话，几秒后还原 —— 与这个文件里原有的提示手法一致 */
  function flashNote(input, text) {
    if (!text) return;
    if (input.dataset.basePlaceholder == null) input.dataset.basePlaceholder = input.placeholder;
    input.placeholder = text;
    clearTimeout(input.noteTimer);
    input.noteTimer = setTimeout(() => {
      input.placeholder = input.dataset.basePlaceholder;
    }, 2800);
  }

  function start(button, input) {
    const recognition = new Engine();
    recognition.lang = 'zh-CN';
    recognition.interimResults = false;
    recognition.continuous = false;

    active = { recognition, button };
    setRecording(button, true);
    input.focus();

    recognition.onresult = (event) => {
      const said = Array.from(event.results)
        .map((r) => (r[0] && r[0].transcript) || '')
        .join('');
      const next = appendTranscript(input.value, said);
      if (next === input.value) return;
      input.value = next;
      // 走一次 input 事件：发送按钮的可用态、文本框高度、题干预览都挂在上面
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const care = input.value.length;
      input.setSelectionRange(care, care);
    };

    recognition.onerror = (event) => {
      flashNote(input, errorText(event.error));
    };

    recognition.onend = () => {
      if (active && active.recognition === recognition) active = null;
      setRecording(button, false);
    };

    try {
      recognition.start();
    } catch {
      active = null;
      setRecording(button, false);
      flashNote(input, '语音启动失败，请直接输入文字');
    }
  }

  for (const { button, input } of pairs) {
    button.addEventListener('click', () => {
      // 再点一次 = 停（界面上是珊瑚色脉冲，学生知道还在录）
      if (active && active.button === button) {
        try {
          active.recognition.stop();
        } catch {
          /* 已经自己停了 */
        }
        return;
      }
      if (active) {
        try {
          active.recognition.stop();
        } catch {
          /* 同上 */
        }
        active = null;
      }
      if (!Engine) {
        input.focus();
        flashNote(input, '当前浏览器不支持语音输入，请用 Chrome 或 Edge');
        return;
      }
      start(button, input);
    });
  }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}
