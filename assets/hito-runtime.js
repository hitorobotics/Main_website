/*!
 * Hito Robotics site runtime.
 * Renders a page template (<template id="app-tpl">) with the page's component.
 * Template syntax: {{ path }} holes in text and attributes, on<event>="{{ handler }}",
 * <sc-if value="{{ cond }}">…</sc-if> and <sc-for list="{{ items }}" as="item">…</sc-for>.
 * Updates are applied in place, so CSS transitions and animations keep running between renders.
 */
(function () {
  'use strict';

  var HOLE = /\{\{\s*([^}]+?)\s*\}\}/g;
  var WHOLE = /^\s*\{\{\s*([^}]+?)\s*\}\}\s*$/;
  var BOOL = { disabled: 1, checked: 1, hidden: 1, selected: 1, readonly: 1, required: 1, open: 1, multiple: 1 };

  function lookup(scope, path) {
    if (path === 'true') return true;
    if (path === 'false') return false;
    if (path === 'null') return null;
    if (/^-?\d+(\.\d+)?$/.test(path)) return Number(path);
    var parts = path.split('.');
    var v = scope[parts[0]];
    for (var i = 1; i < parts.length; i++) {
      if (v == null) return undefined;
      v = v[parts[i]];
    }
    return v;
  }

  function str(v) { return v == null ? '' : String(v); }

  // "a {{ x }} b" -> ['a ', 'x', ' b'] (odd indices are paths)
  function split(text) {
    var out = [], last = 0, m;
    HOLE.lastIndex = 0;
    while ((m = HOLE.exec(text))) {
      out.push(text.slice(last, m.index), m[1].trim());
      last = m.index + m[0].length;
    }
    out.push(text.slice(last));
    return out;
  }

  function interp(parts, scope) {
    var s = '';
    for (var i = 0; i < parts.length; i++) s += (i % 2) ? str(lookup(scope, parts[i])) : parts[i];
    return s;
  }

  function holePath(v) {
    var m = WHOLE.exec(v || '');
    return m ? m[1].trim() : 'false';
  }

  // Turn a container's children into an inert blueprint: a fragment plus a list of bindings
  // addressed by child-index paths. Runs on the <template> contents, so nothing is ever live
  // until bindings have been applied.
  function compile(container) {
    var doc = container.ownerDocument;
    var frag = doc.createDocumentFragment();
    while (container.firstChild) frag.appendChild(container.firstChild);
    var binds = [];
    walk(frag, []);
    return { frag: frag, binds: binds };

    function walk(node, path) {
      for (var i = 0; i < node.childNodes.length; i++) {
        var k = node.childNodes[i];
        var p = path.concat(i);
        if (k.nodeType === 3) {
          if (k.data.indexOf('{{') >= 0) binds.push({ p: p, t: 'text', parts: split(k.data) });
          continue;
        }
        if (k.nodeType !== 1) continue;
        var tag = k.localName;
        if (tag === 'sc-if' || tag === 'sc-for') {
          var b = tag === 'sc-if'
            ? { p: p, t: 'if', cond: holePath(k.getAttribute('value')) }
            : { p: p, t: 'for', list: holePath(k.getAttribute('list')), as: k.getAttribute('as') || 'item' };
          b.sub = compile(k);
          node.replaceChild(doc.createComment(tag), k);
          binds.push(b);
          continue;
        }
        var attrs = Array.prototype.slice.call(k.attributes);
        for (var j = 0; j < attrs.length; j++) {
          var a = attrs[j], n = a.name, v = a.value;
          if (n.indexOf('hint-') === 0) { k.removeAttribute(n); continue; }
          if (v.indexOf('{{') < 0) continue;
          var whole = WHOLE.exec(v);
          k.removeAttribute(n);
          if (whole && n.slice(0, 2) === 'on') {
            binds.push({ p: p, t: 'on', ev: n.slice(2).toLowerCase(), fn: whole[1].trim() });
          } else if (whole && BOOL[n.toLowerCase()]) {
            binds.push({ p: p, t: 'bool', name: n, path: whole[1].trim() });
          } else if (whole) {
            binds.push({ p: p, t: 'attr1', name: n, path: whole[1].trim() });
          } else {
            binds.push({ p: p, t: 'attr', name: n, parts: split(v) });
          }
        }
        walk(k, p);
      }
    }
  }

  function instantiate(bp) {
    var root = document.importNode(bp.frag, true);
    var top = Array.prototype.slice.call(root.childNodes);
    var nodes = bp.binds.map(function (b) {
      var n = root;
      for (var i = 0; i < b.p.length; i++) n = n.childNodes[b.p[i]];
      return n;
    });
    var inst = { root: root, scope: null, kids: [] };
    var ups = bp.binds.map(function (b, i) { return updater(b, nodes[i], inst); });
    inst.update = function (scope) {
      inst.scope = scope;
      for (var i = 0; i < ups.length; i++) ups[i](scope);
    };
    inst.destroy = function () {
      for (var i = 0; i < inst.kids.length; i++) inst.kids[i]();
      for (var j = 0; j < top.length; j++) if (top[j].parentNode) top[j].parentNode.removeChild(top[j]);
    };
    return inst;
  }

  function updater(b, node, inst) {
    var last;
    switch (b.t) {
      case 'text':
        return function (scope) {
          var v = interp(b.parts, scope);
          if (v !== last) { node.data = v; last = v; }
        };
      case 'attr':
        return function (scope) {
          var v = interp(b.parts, scope);
          if (v !== last) { node.setAttribute(b.name, v); last = v; }
        };
      case 'attr1':
        return function (scope) {
          var v = lookup(scope, b.path);
          var s = v == null || v === false && b.name.indexOf('aria-') !== 0 ? null : String(v);
          if (s === last) return;
          last = s;
          if (s === null) node.removeAttribute(b.name); else node.setAttribute(b.name, s);
        };
      case 'bool':
        return function (scope) {
          var v = !!lookup(scope, b.path);
          if (v === last) return;
          last = v;
          if (v) node.setAttribute(b.name, ''); else node.removeAttribute(b.name);
        };
      case 'on':
        node.addEventListener(b.ev, function (e) {
          var fn = inst.scope && lookup(inst.scope, b.fn);
          if (typeof fn === 'function') return fn(e);
        });
        return function () {};
      case 'if':
        var child = null;
        inst.kids.push(function () { if (child) { child.destroy(); child = null; } });
        return function (scope) {
          if (lookup(scope, b.cond)) {
            if (!child) {
              child = instantiate(b.sub);
              child.update(scope);
              node.parentNode.insertBefore(child.root, node);
            } else {
              child.update(scope);
            }
          } else if (child) {
            child.destroy();
            child = null;
          }
        };
      case 'for':
        var items = [];
        inst.kids.push(function () { items.forEach(function (it) { it.destroy(); }); items = []; });
        return function (scope) {
          var list = lookup(scope, b.list) || [];
          for (var i = 0; i < list.length; i++) {
            var s = Object.create(scope);
            s[b.as] = list[i];
            s.$index = i;
            if (!items[i]) {
              items[i] = instantiate(b.sub);
              items[i].update(s);
              node.parentNode.insertBefore(items[i].root, node);
            } else {
              items[i].update(s);
            }
          }
          while (items.length > list.length) items.pop().destroy();
        };
    }
    return function () {};
  }

  // Minimal class-component base with batched, React-like setState.
  var app = null;
  var queue = [];
  var scheduled = false;

  function DCLogic(props) {
    this.props = props || {};
    this.state = {};
  }
  DCLogic.prototype.setState = function (update, cb) {
    queue.push({ u: update, cb: cb });
    schedule();
  };
  DCLogic.prototype.forceUpdate = function (cb) {
    queue.push({ u: null, cb: cb });
    schedule();
  };

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    Promise.resolve().then(flush);
  }

  function flush() {
    scheduled = false;
    if (!app) return;
    var comp = app.comp;
    var q = queue;
    queue = [];
    var s = comp.state, cbs = [];
    for (var i = 0; i < q.length; i++) {
      var u = q[i].u;
      var part = typeof u === 'function' ? u(s, comp.props) : u;
      if (part) s = Object.assign({}, s, part);
      if (q[i].cb) cbs.push(q[i].cb);
    }
    comp.state = s;
    app.inst.update(comp.renderVals());
    for (var j = 0; j < cbs.length; j++) cbs[j].call(comp);
  }

  function mount(Component, props) {
    var tpl = document.getElementById('app-tpl');
    var host = document.getElementById('app');
    var bp = compile(tpl.content);
    var comp = new Component(props || {});
    var inst = instantiate(bp);
    app = { comp: comp, inst: inst };
    inst.update(comp.renderVals());
    host.appendChild(inst.root);
    if (typeof comp.componentDidMount === 'function') comp.componentDidMount();
    window.addEventListener('pagehide', function () {
      if (typeof comp.componentWillUnmount === 'function') comp.componentWillUnmount();
    });
  }

  window.DCLogic = DCLogic;
  window.HitoApp = { mount: mount };
})();
