export default `
window.$pagedata = {}
if (window && window?.pagedata) {
    try {
        window.$pagedata = JSON.parse(window.pagedata.textContent);
    } catch (e) {
        console.error('Failed to parse pagedata:', e);
    }
}
const FILTERS = Symbol('filters');
const FETCH = Symbol('fetch');

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
            if(!i[$key]) return false;
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
`;