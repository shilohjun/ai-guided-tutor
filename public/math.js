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
    var skip = (opts && opts.includeCode) ? 'pre, script, style, .katex' : 'code, pre, script, style, .katex';
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
    renderBlock: renderBlock
  };
})();
