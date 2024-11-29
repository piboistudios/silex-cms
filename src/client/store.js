// if (window && window?.pagedata) {
//     try {
//         window.$pagedata = JSON.parse(window.pagedata.textContent);
//     } catch (e) {
//         console.error('Failed to parse pagedata:', e);
//     }
// }
const FILTERS = Symbol('filters');
const FETCH = Symbol('fetch');

obj = {
    "#foo": { foo: 'bar' },
    baz: 'quz'
}
function box(primitive) {
    return new Proxy({ value: primitive }, {
        get(target, prop, receiver) {
            if (prop === 'valueOf') return () => primitive?.valueOf?.();

            const prim = Reflect.get(target, 'value');
            const value = prim?.[prop];
            return typeof value === 'function' ? value.bind(prim) : value;
        }
    });
}
const PROMISE_FNS = ['then', 'catch', 'finally']
function accessible(promise) {
    return new Proxy(promise, {
        get(target, prop) {
            if (PROMISE_FNS.includes(prop)) return target[prop].bind(target);
            if (prop === 'withFilter') {
                return Object.prototype.withFilter.bind(target);
            }
            return accessible(target.then(v => v[prop]))
        }
    });
}
Object.prototype.withFilters = function (filters) {
    filters.forEach(f => {
        this.withFilter(...f);
    });
    return this;
}
const EXTENSIBLE_TYPES = ['object', 'function']
Object.prototype.withFilter = function (filter, options) {
    let target = !EXTENSIBLE_TYPES.includes(typeof this) ? box(this) : this;
    if (!target[FILTERS]) {
        if (target instanceof Promise) {

            target = target.then(v => {
                if (v) {
                    v = v.withFilters(target[FILTERS]);
                }
                return v;
            });
        }
        if (target.$FETCH instanceof Function) {
            const fetch = target.$FETCH.bind(target);
            target.$FETCH = function () {
                return fetch()
                    .then(v => {
                        if (v) {
                            v = v.withFilters(target[FILTERS]);
                        }
                        return v;
                    })
            }
        }
    }
    target[FILTERS] ??= [];
    target[FILTERS].push([filter, options].filter(Boolean));
    if (EXTENSIBLE_TYPES.includes(typeof target)) {
        const raw = target;
        target = new Proxy(target, {
            get(_target, prop) {
                if (prop === 'valueOf') return () => raw?.valueOf?.();

                if (PROMISE_FNS.concat([FILTERS]).includes(prop)) return typeof _target[prop] !== 'function' ?
                    _target[prop] : _target[prop].bind(_target);

                const _v = _target?.filtered?.(false)?.[prop];
                const v = typeof _v === 'function' ? _v.bind(_target) : _v;
                return v;
            }
        })
    }
    return target;
}
Object.prototype.filtered = function (unbox = true) {
    let v = this;
    if (v[FILTERS] && !v[FILTERS].running) {
        v[FILTERS].running = true;
        try {
            for (const [filter, params] of v[FILTERS]) {
                v = filter(v, params)?.filtered?.();
            }
        } catch (e) {
            console.error("Failed to run filter:", e);
        }
        finally {
            delete this[FILTERS].running;
        }
    }

    return unbox ? v?.valueOf?.() : v;
}
const DEFAULT_FILTER = ($key = '$$opts') => (v, opts) => {
    const raw = v?.valueOf?.();
    if (raw instanceof Array) return !Object.values(opts).length ? raw : raw.find(i => {
        for (const key in opts) {
            if (!i[$key]) return false;
            if (typeof opts[key] === 'function') continue;
            if (!(key in i[$key]) || opts[key] !== i?.[$key]?.[key]) {
                return false;
            }
        }
        return true;
    })?.$$value
    return v;
}
function reloadable(obj, _fetch, _ensure, opts = {}, root) {
    if (obj === undefined) return obj;
    obj[FETCH] = _fetch;
    root ??= obj;
    _ensure ??= DEFAULT_FILTER();
    const ensure = (v) => {
        const r = _ensure(v, opts);
        return r;
    };
    const fetch = () => _fetch(opts).then(v => (delete obj.$$empty, reloadable(v, _fetch, _ensure, opts)));
    function _set(newopts) {
        for (const key in opts) {
            delete opts[key];
        }
        Object.assign(opts, newopts);
        return reloadable(ensure(set), _fetch, _ensure);
    }
    _set.toJSON = () => obj;

    const set = new Proxy(_set, {
        get(target, prop) {
            if (prop === 'valueOf') return () => obj?.valueOf?.();
            if (prop === '$$empty') return obj[prop];
            const v = obj[prop] ? typeof obj[prop] === 'function' ?
                obj[prop].bind(obj) : obj[prop] :
                typeof target[prop] === 'function' ? target[prop].bind(target) : target[prop];
            return v;
        },
        set(target, prop, value) {
            const owner = obj[prop] ? obj : target;
            return owner[prop] = value;
        }
    })
    const p = new Proxy(set, {
        get(target, prop) {
            if (prop === 'valueOf') return () => obj?.valueOf?.();

            if (prop === "$ENSURE") return function () {
                if (root.$$empty) {
                    return fetch();
                }
                else return ensure(p);
            }
            if (prop === '$$empty') return obj[prop];
            if (prop === FETCH) return fetch;
            if (prop === '$FETCH') return fetch;
            if (['withFilter', 'filtered'].includes(prop)) {
                return function () {
                    const ret = target[prop](...arguments);
                    return reloadable(ret, () => fetch().then(v => {
                        return v[prop](...arguments)
                    }), ensure, opts, root);
                }
            }
            const property = target[prop] || obj[prop];
            // if (property === undefined || property === null) return property;
            let v = typeof property === 'function' ? property.bind(target) : property;
            v = maybeBox(v);
            const ret = reloadable(v, () => fetch().then(v => {
                return v[prop];
            }), _ensure, opts, root)
            return ret;
        }
    })
    return p;
}
function maybeBox(v) {
    if (!EXTENSIBLE_TYPES.includes(typeof v)) {
        v = box(v);
    }
    return v;
}
//// TESTS
function synctest() {


    let o = (5).withFilter(o => (console.log("Filter#1: " + o), o))
    o = o.withFilter(o => o + 1);
    o = o.withFilter(o => o + 1);
    o = o.withFilter(o => o + 1);
    o = o.withFilter(o => o + 1);
    o = o.withFilter(o => (console.log("Filter#2: " + o), o))
    console.log("o " + o);
    console.log("o filtered " + o.filtered());
    console.log("o filtered " + o.filtered());
    console.log(o.filtered() + o);
    console.assert(o.valueOf() === 5);
    console.assert(o.filtered().valueOf() === 9);
    console.assert(o.filtered() + o === 14);
}
function promisetest() {


    let o = Promise.resolve(5).withFilter(o => (console.log("Filter#1: " + o), o))
    o = o.withFilter(o => o + 1);
    o = o.withFilter(o => o + 1);
    o = o.withFilter(o => o + 1);
    o = o.withFilter(o => o + 1);
    o = o.withFilter(o => (console.log("Filter#2: " + o), o))
    o.then(o => {

        console.log("o " + o);
        console.log("o filtered " + o.filtered());
        console.log("o filtered " + o.filtered());
        console.log(o.filtered() + o);
        console.assert(o.valueOf() === 5);
        console.assert(o.filtered().valueOf() === 9);
        console.assert(o.filtered() + o === 14);
    });
    o = accessible(Promise.resolve({ foo: 'bar', baz: { quz: 'qux' } }));
    let m = o.foo;
    let n = o.baz.quz;
    let q = n.withFilter(qux => qux + 'foobarbaz')
    q = q.withFilter(w => w.split('').reverse().join(''))
    Promise.all([o, m, n, q]).then(all => {
        console.log("results:", all.map(a => a.filtered().valueOf()));
    });
    let f = reloadable({ foo: 'bar2', baz: { quz: 'qux2' } }, (opts) => Promise.resolve({ foo: 'bar2new', baz: { quz: 'qux2new' }, opts }));
    const cached = f({ petId: 1 });
    console.log("cached:", cached.valueOf());
    const r = f.$FETCH();
    const prop = f.baz.quz;
    const filtered = prop.withFilter(v => v + '_filtered');
    console.log("filter fetch:", filtered.$FETCH);
    console.log("prop fetch:", prop.$FETCH, prop[FETCH]);
    console.log("filtered === f", filtered === prop);
    const t = filtered.$FETCH();
    const x = f.opts.$FETCH();
    const z = t.withFilter(d => d + '_yet_again');
    const y = filtered.$ENSURE();
    Promise.all([r, t, x, z, y]).then(all => {
        console.log("results:", all.map(a => a.filtered().valueOf()));
    });
    f = reloadable({ $$empty: false, foo: 'bar2', baz: { quz: 'qux2' } }, (opts) => Promise.resolve({ foo: 'bar3new', baz: { quz: 'qux3new' }, opts }));
    const ensured = f.baz.quz.withFilter(v => v + '_loaded_and_filtered').$ENSURE();
    console.log("ensured (should be promise)", JSON.stringify(ensured), f?.$$empty?.valueOf?.());
    f = reloadable({
        $$empty: false, foo: 'bar2', baz: [
            { $$opts: { waldo: 1, w: 1 }, $$value: { quz: 'qux2::waldo' } },
            { $$opts: { graply: 1, w: 2 }, $$value: { quz: 'qux2::graply' } },
        ]
    }, (opts) => Promise.resolve({ foo: 'bar3new', baz: { quz: 'qux3new' }, opts }));
    setTimeout(() => {
        /**
         * @todo oh right... make withFilter not alter object in place...
         */
        console.log("test 1...", f.baz({ w: 1 })?.$ENSURE?.()?.filtered?.()?.valueOf?.());
        console.log("test 2...", f.baz({ w: 1 }).withFilter(v => ({ ...v, quz: v.quz + 'whoafilter1::' })).quz.withFilter(v => v + '_filteredagain').$ENSURE().filtered());
        console.log("test 1...", f.baz({ w: 1 })?.$ENSURE?.()?.filtered?.()?.valueOf?.());
        console.log("test 2...", f.baz({ w: 1 }).withFilter(v => ({ ...v, quz: v.quz + 'whoafilter1::' })).quz.withFilter(v => v + '_filteredagain').$ENSURE().filtered());
        console.log("test 1...", f.baz({ w: 1 })?.$ENSURE?.()?.filtered?.()?.valueOf?.());
        console.log("test 2...", f.baz({ w: 1 }).withFilter(v => ({ ...v, quz: v.quz + 'whoafilter1::' })).quz.withFilter(v => v + '_filteredagain').$ENSURE().filtered());
        console.log("test 1...", f.baz({ w: 1 })?.$ENSURE?.()?.filtered?.()?.valueOf?.());
        console.log("test 2...", f.baz({ w: 1 }).withFilter(v => ({ ...v, quz: v.quz + 'whoafilter1::' })).quz.withFilter(v => v + '_filteredagain').$ENSURE().filtered());
        console.log("test 1...", f.baz({ w: 1 })?.$ENSURE?.()?.filtered?.()?.valueOf?.());
        console.log("test 2...", f.baz({ w: 1 }).withFilter(v => ({ ...v, quz: v.quz + 'whoafilter1::' })).quz.withFilter(v => v + '_filteredagain').$ENSURE().$ENSURE().filtered().$ENSURE().filtered().slice());
        console.log('wat', f.baz({ waldo: 1 }).withFilter(v => v).quz.$ENSURE().filtered().valueOf())
    }, 1)

}
function test() {
    synctest();
    promisetest();
}
test();