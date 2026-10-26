/**
 * 公网访问口令门（DEMO_ACCESS_CODE）的行为契约。
 *
 * 为什么这组用例值得单独写：
 *
 *   1. **默认必须仍然是关的。** 这套口令门是给"想在自己的部署上开真模型"的人用的，
 *      不是把公网默认从"安全"改成"不安全"。没配 DEMO_ACCESS_CODE 时，
 *      行为必须和以前一模一样（强制离线桩）。
 *
 *   2. **同一个实例上不能串号。** serverless 的一个实例会连续处理多个请求，
 *      而 process.env 是进程级的。如果实现方式是在请求里 delete/还原 env，
 *      那么一个带口令的请求跑过之后，后续没带口令的请求会白捡到真模型 ——
 *      这正是"加了口令等于没加"的经典塌方方式。
 *      所以这里专门有一条"先解锁、再错口令"的回归用例。
 *
 *   3. **健康检查要能看出当前是哪种形态**，否则线上排查只能靠猜。
 */

import { describe, it, assertEquals, assert } from './runner.js';
import handler from '../api/index.js';

/** 造一个最小的 IncomingMessage 替身（health 是 GET，不需要流） */
function makeReq({ method = 'GET', url = '/api/health', headers = {}, body } = {}) {
  return { method, url, headers: { host: 'probe.local', ...headers }, body, on() {} };
}

/** 造一个收集输出的 ServerResponse 替身 */
function makeRes() {
  const out = { statusCode: 200, headers: {}, body: '' };
  return {
    get statusCode() { return out.statusCode; },
    set statusCode(v) { out.statusCode = v; },
    headersSent: false,
    setHeader(k, v) { out.headers[String(k).toLowerCase()] = v; },
    end(chunk) { if (chunk) out.body += chunk; this.headersSent = true; },
    _out: out,
  };
}

async function callApi(reqInit) {
  const req = makeReq(reqInit);
  const res = makeRes();
  await handler(req, res);
  let json = null;
  try { json = JSON.parse(res._out.body); } catch {}
  return { status: res._out.statusCode, json };
}

/**
 * 临时设置环境变量，结束后还原。
 * 必须还原：同一进程里后面还有别的套件要跑。
 */
async function withEnv(overrides, fn) {
  const keys = ['LLM_API_KEY', 'OPENAI_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL',
    'DEMO_ACCESS_CODE', 'ALIYUN_OCR_APPCODE', 'PUBLIC_DEMO_FORCE_OFFLINE', 'PUBLIC_DEMO_ALLOW_OCR'];
  const saved = {};
  for (const k of keys) saved[k] = process.env[k];

  for (const k of keys) delete process.env[k];
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) process.env[k] = v;
  }

  try {
    return await fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const FAKE_KEY = 'sk-test-not-a-real-key';
const FAKE_BASE = 'https://example.invalid/v1';
const FAKE_MODEL = 'test-model';

describe('公网口令门 · 默认仍然是关的', () => {
  it('没有任何配置时，即使存在 LLM Key 也一律走离线桩', async () => {
    await withEnv({ LLM_API_KEY: FAKE_KEY, LLM_BASE_URL: FAKE_BASE, LLM_MODEL: FAKE_MODEL }, async () => {
      const { status, json } = await callApi();
      assertEquals(status, 200, '健康检查应 200');
      assertEquals(json.engine, 'offline-stub', '没配口令时必须离线');
      assertEquals(json.llmConfigured, false, '没配口令时不得报告已配置模型');
    });
  });

  it('配了口令但请求没带，仍然离线', async () => {
    await withEnv({
      LLM_API_KEY: FAKE_KEY, LLM_BASE_URL: FAKE_BASE, LLM_MODEL: FAKE_MODEL,
      DEMO_ACCESS_CODE: 'let-me-in',
    }, async () => {
      const { json } = await callApi();
      assertEquals(json.engine, 'offline-stub', '没带口令必须离线');
    });
  });

  it('配了口令但口令错误，仍然离线', async () => {
    await withEnv({
      LLM_API_KEY: FAKE_KEY, LLM_BASE_URL: FAKE_BASE, LLM_MODEL: FAKE_MODEL,
      DEMO_ACCESS_CODE: 'let-me-in',
    }, async () => {
      const { json } = await callApi({ url: '/api/health?code=wrong-code' });
      assertEquals(json.engine, 'offline-stub', '错口令必须离线');
    });
  });
});

describe('公网口令门 · 带对口令才放行', () => {
  it('口令放在查询参数里，放行真模型', async () => {
    await withEnv({
      LLM_API_KEY: FAKE_KEY, LLM_BASE_URL: FAKE_BASE, LLM_MODEL: FAKE_MODEL,
      DEMO_ACCESS_CODE: 'let-me-in',
    }, async () => {
      const { json } = await callApi({ url: '/api/health?code=let-me-in' });
      assertEquals(json.engine, 'llm', '带对口令应放行真模型');
      assertEquals(json.llmConfigured, true, '应报告已配置模型');
      assertEquals(json.model, FAKE_MODEL, '模型名应透出');
    });
  });

  it('口令放在请求头里也放行', async () => {
    await withEnv({
      LLM_API_KEY: FAKE_KEY, LLM_BASE_URL: FAKE_BASE, LLM_MODEL: FAKE_MODEL,
      DEMO_ACCESS_CODE: 'let-me-in',
    }, async () => {
      const { json } = await callApi({ headers: { 'x-demo-code': 'let-me-in' } });
      assertEquals(json.engine, 'llm', '请求头带口令也应放行');
    });
  });

  it('口令对时，拍照识题凭据一并放行', async () => {
    await withEnv({
      LLM_API_KEY: FAKE_KEY, LLM_BASE_URL: FAKE_BASE, LLM_MODEL: FAKE_MODEL,
      DEMO_ACCESS_CODE: 'let-me-in',
      ALIYUN_OCR_APPCODE: 'fake-appcode',
    }, async () => {
      const { json } = await callApi({ url: '/api/health?code=let-me-in' });
      assertEquals(json.ocr.configured, true, '口令对时 OCR 凭据应可用');
    });
  });

  it('口令不对时，拍照识题凭据必须仍然关闭', async () => {
    await withEnv({
      LLM_API_KEY: FAKE_KEY, LLM_BASE_URL: FAKE_BASE, LLM_MODEL: FAKE_MODEL,
      DEMO_ACCESS_CODE: 'let-me-in',
      ALIYUN_OCR_APPCODE: 'fake-appcode',
    }, async () => {
      const { json } = await callApi({ url: '/api/health?code=nope' });
      assertEquals(json.ocr.configured, false, '错口令不得放行 OCR');
    });
  });
});

describe('公网口令门 · 同一实例上不许串号', () => {
  it('先解锁一次，随后不带口令的请求必须回到离线桩', async () => {
    await withEnv({
      LLM_API_KEY: FAKE_KEY, LLM_BASE_URL: FAKE_BASE, LLM_MODEL: FAKE_MODEL,
      DEMO_ACCESS_CODE: 'let-me-in',
    }, async () => {
      const unlocked = await callApi({ url: '/api/health?code=let-me-in' });
      assertEquals(unlocked.json.engine, 'llm', '第一发带对口令，应放行');

      const locked = await callApi();
      assertEquals(
        locked.json.engine,
        'offline-stub',
        '解锁过的实例上，后续无口令请求不得白捡真模型（adapter 缓存串号）',
      );
      assertEquals(locked.json.llmConfigured, false, '无口令请求不得报告已配置模型');
    });
  });

  it('交替请求也不会互相污染', async () => {
    await withEnv({
      LLM_API_KEY: FAKE_KEY, LLM_BASE_URL: FAKE_BASE, LLM_MODEL: FAKE_MODEL,
      DEMO_ACCESS_CODE: 'let-me-in',
    }, async () => {
      const a = await callApi();
      const b = await callApi({ url: '/api/health?code=let-me-in' });
      const c = await callApi();
      assertEquals(a.json.engine, 'offline-stub', '第一发无口令应离线');
      assertEquals(b.json.engine, 'llm', '第二发带口令应放行');
      assertEquals(c.json.engine, 'offline-stub', '第三发无口令必须回到离线');
    });
  });
});

describe('公网口令门 · 健康检查要能看出形态', () => {
  it('没配口令时报告 gate=off', async () => {
    await withEnv({ LLM_API_KEY: FAKE_KEY }, async () => {
      const { json } = await callApi();
      assertEquals(json.demoGate, 'off', '未配置口令时应报 off');
    });
  });

  it('配了口令且带对时报告 gate=unlocked', async () => {
    await withEnv({ DEMO_ACCESS_CODE: 'let-me-in' }, async () => {
      const { json } = await callApi({ url: '/api/health?code=let-me-in' });
      assertEquals(json.demoGate, 'unlocked', '带对口令时应报 unlocked');
    });
  });

  it('配了口令但没带时报告 gate=locked', async () => {
    await withEnv({ DEMO_ACCESS_CODE: 'let-me-in' }, async () => {
      const { json } = await callApi();
      assertEquals(json.demoGate, 'locked', '未带口令时应报 locked');
    });
  });
});

describe('公网口令门 · 会话不能继承上一次的模型形态', () => {
  /**
   * 这是实测撞出来的坑，不是假想：
   *   会话按 sessionId 缓存在进程内存里，而 engine 持有创建它时的 adapter。
   *   如果不清形态，先用公开链接建会话、再带口令进来，引擎仍然是离线桩；
   *   反过来更糟 —— 带口令建的会话被没口令的人接着用，就白蹭了真模型。
   */
  it('同一 sessionId 在两种形态之间切换时，必须换引擎', async () => {
    const { getSession, requestEnv } = await import('../src/server/router.js');

    await withEnv({}, async () => {
      const lockedEnv = { ...process.env };
      delete lockedEnv.LLM_API_KEY;
      delete lockedEnv.OPENAI_API_KEY;

      const unlockedEnv = {
        ...process.env,
        LLM_API_KEY: FAKE_KEY,
        LLM_BASE_URL: FAKE_BASE,
        LLM_MODEL: FAKE_MODEL,
      };

      const sid = 'gate-session-switch';
      const locked = requestEnv.run(lockedEnv, () => getSession(sid, 'phy-emi-01'));
      const engineOffline = locked.engine;
      assertEquals(locked.adapterTag, 'offline', '无 Key 时应记为 offline 形态');

      const unlocked = requestEnv.run(unlockedEnv, () => getSession(sid, 'phy-emi-01'));
      /** 必须先取出引用再进下一步：getSession 返回的是同一个会话对象，
       *  直接写 unlocked.engine 会在第三步之后读到被替换后的新引擎，等于自己跟自己比。 */
      const engineLlm = unlocked.engine;
      assert(engineLlm !== engineOffline, '形态变了必须重建引擎，不能沿用旧的离线引擎');
      assert(unlocked.adapterTag !== 'offline', '带 Key 时形态标签应发生变化');

      const backToLocked = requestEnv.run(lockedEnv, () => getSession(sid, 'phy-emi-01'));
      assert(backToLocked.engine !== engineLlm, '退回无口令时必须再换回离线引擎');
      assertEquals(backToLocked.adapterTag, 'offline', '应回到 offline 形态');
    });
  });

  it('形态没变时不要重建引擎（否则每轮对话都会丢诊断位置）', async () => {
    const { getSession, requestEnv } = await import('../src/server/router.js');

    await withEnv({}, async () => {
      const lockedEnv = { ...process.env };
      delete lockedEnv.LLM_API_KEY;
      delete lockedEnv.OPENAI_API_KEY;

      const sid = 'gate-session-stable';
      const first = requestEnv.run(lockedEnv, () => getSession(sid, 'phy-emi-02'));
      const engineBefore = first.engine;
      const second = requestEnv.run(lockedEnv, () => getSession(sid, 'phy-emi-02'));
      assertEquals(second.engine, engineBefore, '同一形态下应复用同一个引擎');
    });
  });
});

describe('公网口令门 · 显式开关仍然有效', () => {
  it('PUBLIC_DEMO_FORCE_OFFLINE=0 时即使没口令也放行（老行为，不能被口令门破坏）', async () => {
    await withEnv({
      LLM_API_KEY: FAKE_KEY, LLM_BASE_URL: FAKE_BASE, LLM_MODEL: FAKE_MODEL,
      PUBLIC_DEMO_FORCE_OFFLINE: '0',
    }, async () => {
      const { json } = await callApi();
      assertEquals(json.engine, 'llm', '显式关掉强制离线后应放行');
    });
  });

  it('口令门存在时，PUBLIC_DEMO_FORCE_OFFLINE=0 不得绕过口令', async () => {
    await withEnv({
      LLM_API_KEY: FAKE_KEY, LLM_BASE_URL: FAKE_BASE, LLM_MODEL: FAKE_MODEL,
      PUBLIC_DEMO_FORCE_OFFLINE: '0',
      DEMO_ACCESS_CODE: 'let-me-in',
    }, async () => {
      const { json } = await callApi();
      assertEquals(json.engine, 'offline-stub', '配了口令就必须服从口令，不能被旧开关绕过');
      assert(true);
    });
  });
});
