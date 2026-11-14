/* 公式渲染：把文字里的 LaTeX 片段交给 KaTeX 画出来。
   支持 $...$、$$...$$、\(...\)、\[...\] 四种写法；不认识的语法交给 KaTeX 自己报红，不静默吞掉。
   引擎读到的仍然是原始文本（带反斜杠），这只是显示层。 */
(function () {
  if (typeof katex === 'undefined') return;

  var PATTERN = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$([^$\n]+?)\$/g;

  function texOf(match, d1, d2, d3, inline) {
    if (d1 != null) return { tex: d1, display: true };
    if (d2 != null) return { tex: d2, display: true };
    if (d3 != null) return { tex: d3, display: false };
    return { tex: inline, display: false };
  }

  function hasMath(text) {
    PATTERN.lastIndex = 0;
    return PATTERN.test(text);
  }

  /* 把一段纯文本里的公式换成 KaTeX 的 span，其余照旧转义 */
  function renderToHtml(text) {
    var out = '';
    var last = 0;
    PATTERN.lastIndex = 0;
    var m;
    while ((m = PATTERN.exec(text))) {
      out += escText(text.slice(last, m.index));
      var info = texOf(m, m[1], m[2], m[3], m[4]);
      try {
        out += katex.renderToString(info.tex.trim(), {
          displayMode: info.display,
          throwOnError: false,
          strict: false,
          trust: false
        });
      } catch (e) {
        out += escText(m[0]);
      }
      last = m.index + m[0].length;
    }
    out += escText(text.slice(last));
    return out;
  }

  function escText(s) {
    return s.replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /* 就地渲染已经排进 DOM 的文字节点（对话气泡、题面等） */
  function renderMathIn(root, opts) {
    if (!root) return;
    /* 必须躲开的：脚本与样式本身，以及所有表单控件 ——
       textarea 的默认值就是一个文本子节点，被替换成 span 之后 value 就废了。
       自动渲染会扫整页，所以这条不再是理论风险。 */
    var skipAlways = 'script, style, textarea, input, select, option, .katex';
    var skip = (opts && opts.includeCode) ? skipAlways + ', pre' : skipAlways + ', code, pre';
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        if (!node.nodeValue || !hasMath(node.nodeValue)) return NodeFilter.FILTER_REJECT;
        var p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (p.closest(skip)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var nodes = [];
    var n;
    while ((n = walker.nextNode())) nodes.push(n);
    nodes.forEach(function (node) {
      var box = document.createElement('span');
      box.className = 'mathrun';
      box.innerHTML = renderToHtml(node.nodeValue);
      node.parentNode.replaceChild(box, node);
    });
  }

  function renderBlock(el, text) {
    if (!el) return false;
    if (!text || !hasMath(text)) {
      el.hidden = true;
      el.innerHTML = '';
      return false;
    }
    var paras = text.split(/\n{2,}/).map(function (chunk) {
      return '<p>' + renderToHtml(chunk).replace(/\n/g, '<br>') + '</p>';
    }).join('');
    el.innerHTML = paras;
    el.hidden = false;
    return true;
  }

  window.BsjMath = {
    hasMath: hasMath,
    renderToHtml: renderToHtml,
    renderMathIn: renderMathIn,
    renderBlock: renderBlock,
    /* 关掉自动渲染的开关：万一哪个页面想完全手动控制，把它置 false 就行 */
    autoRender: true,
    /* 装好之后指向那个 MutationObserver —— 排查「公式为什么没画」时先看它 */
    observer: null
  };

  /* ==========================================================================
     自动渲染：新内容进页面就自己过一遍 KaTeX
     ==========================================================================
     为什么要有这一层：显示点是一个只会变长的清单。首屏预览、第 3 页题干、
     聊天气泡、推荐区预览、地图详情、工坊列表……每加一个，都要记得补一次
     renderMathIn。2026-11 就漏过一次：首屏摊开题库题干时，570 道新题
     （公式是 $…$ 原文，不是旧那种 <img class="qf"> 图片）整屏显示 LaTeX 源码。

     所以把「渲染」从每个调用点挪到这里：观察 body，谁被塞进来、谁的文字被改写，
     就画谁。显式调用点保留 —— 它们让首帧就画好，不会有一闪而过的源码；
     这一层只兜底，幂等，重复跑不产生二次渲染。

     不会死循环：KaTeX 插进去的节点都包在 .katex 里，主循环直接跳过，
     第二轮扫不到东西，自然收敛。
     ========================================================================== */
  function installAutoRender() {
    var pending = [];
    var scheduled = false;

    function skipSubtree(el) {
      return !!(el.closest && el.closest('script, style, textarea, input, select, option, .katex'));
    }

    function collect(node) {
      if (!node) return;
      var el = node.nodeType === 1 ? node : (node.nodeType === 3 ? node.parentElement : null);
      if (!el) return;
      pending.push(el);
      schedule();
    }

    /* 一帧内的多次变更合成一次；嵌套的只留最外层，同一棵树不走两遍 */
    function flush() {
      scheduled = false;
      var list = pending;
      pending = [];
      if (!window.BsjMath.autoRender) return;
      if (list.length > 60) list = [document.body];
      var targets = list.filter(function (el) {
        if (!el.isConnected) return false;
        return !list.some(function (other) { return other !== el && other.contains(el); });
      });
      targets.forEach(function (el) {
        if (skipSubtree(el)) return;
        renderMathIn(el);
      });
    }

    function schedule() {
      if (scheduled) return;
      scheduled = true;
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
      else setTimeout(flush, 16);
    }

    /* math.js 是在 body 里执行的，这时文档可能只解析了一半：
       先扫一遍已经存在的，剩下的交给观察器 —— 后面插入的每个节点都会被看见。 */
    renderMathIn(document.body);

    var mo = new MutationObserver(function (records) {
      if (!window.BsjMath.autoRender) return;
      for (var i = 0; i < records.length; i++) {
        var r = records[i];
        if (r.type === 'characterData') { collect(r.target); continue; }
        for (var j = 0; j < r.addedNodes.length; j++) collect(r.addedNodes[j]);
      }
    });
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    window.BsjMath.observer = mo;
    return mo;
  }

  if (document.body) installAutoRender();
  else document.addEventListener('DOMContentLoaded', installAutoRender);
})();
