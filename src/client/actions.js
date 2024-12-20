export const ACTIONS_JS = {
    drill: function drill(obj, ...path) {

        path = path.filter(Boolean).flatMap(p => p.split('.'))
        return path.reduce((result, part, index, array) => {
            if (index === array.length - 1) {
                return [result ?? {}, part]
            }
            return result?.[part];
        }, obj)
    },
    run_all: function run_all(...fns/* : Function[] */) {
        while (fns.length) {
            const fn = fns.shift();
            const v = fn();
            if (v instanceof Promise) {
                return v.then(() => {
                    return run_all(...fns)
                })
            }
        }
    },
    for_of: function for_of({ of, stmt }) {
        if (of instanceof Promise) {
            return of.then(of => for_of({ of, stmt }));
        }
        let prev;
        for (const _of of of) {
            if (prev instanceof Promise) {
                prev
                    .then(() => {
                        prev = stmt(_of);
                    })
            } else {
                prev = stmt(_of);
            }
        }
        return prev;
    },
    case: function _case({ test, consequent, alternate }) {
        if (test) {
            return consequent();
        } else {
            return alternate();
        }
    },
    toggle_state: function toggle_state({
        $data,
        key,
        prop
    }) {
        const [obj, property] = this.drill($data, key, prop);
        obj[property] = !obj[property];
    },
    flag_state: function flag_state({
        $data,
        key,
        prop
    }) {
        const [obj, property] = this.drill($data, key, prop);
        obj[property] = true;
    },
    unflag_state: function unflag_state({
        $data,
        key,
        prop
    }) {
        const [obj, property] = this.drill($data, key, prop);
        obj[property] = false;
    },
    subtract_from_state: function subtract_from_state({
        $data,
        key,
        prop,
        value
    }) {
        const [obj, property] = this.drill($data, key, prop);
        if (value?.$FETCH instanceof Function) {
            return value.$FETCH()
                .then(value => {
                    if (value === null || value === undefined) return;
                    obj[property] -= value;
                })
        } else if (value instanceof Promise) {
            return value.then(value => {
                if (value === null || value === undefined) return;
                obj[property] -= value;
            })
        } else {
            if (value === null || value === undefined) return;
            obj[property] -= value;
        }
    },
    add_to_state: function add_to_state({
        $data,
        key,
        prop,
        value
    }) {
        const [obj, property] = this.drill($data, key, prop);
        if (value?.$FETCH instanceof Function) {
            return value.$FETCH()
                .then(value => {
                    if (value === null || value === undefined) return;
                    obj[property] += value;
                })
        } else if (value instanceof Promise) {
            return value.then(value => {
                if (value === null || value === undefined) return;
                obj[property] += value;
            })
        } else {
            if (value === null || value === undefined) return;
            obj[property] += value;
        }
    },
    prepend_to_state: function prepend_to_state({
        $data,
        key,
        prop,
        value
    }) {
        const [obj, property] = this.drill($data, key, prop);
        if (value?.$FETCH instanceof Function) {
            return value.$FETCH()
                .then(value => {
                    if (value === null || value === undefined) return;
                    obj[property] = value + obj[property];
                })
        } else if (value instanceof Promise) {
            return value.then(value => {
                if (value === null || value === undefined) return;
                obj[property] = value + obj[property];
            })
        } else {
            if (value === null || value === undefined) return;
            obj[property] = value + obj[property];
        }
    },
    multiply_state: function multiply_state({
        $data,
        key,
        prop,
        value
    }) {
        const [obj, property] = this.drill($data, key, prop);
        if (value?.$FETCH instanceof Function) {
            return value.$FETCH()
                .then(value => {
                    if (value === null || value === undefined) return;
                    obj[property] *= value;
                })
        } else if (value instanceof Promise) {
            return value.then(value => {
                if (value === null || value === undefined) return;
                obj[property] *= value;
            })
        } else {
            if (value === null || value === undefined) return;
            obj[property] *= value;
        }
    },
    divide_state: function divide_state({
        $data,
        key,
        prop,
        value
    }) {
        const [obj, property] = this.drill($data, key, prop);
        if (value?.$FETCH instanceof Function) {
            return value.$FETCH()
                .then(value => {
                    if (value === null || value === undefined) return;
                    obj[property] /= value;
                })
        } else if (value instanceof Promise) {
            return value.then(value => {
                if (value === null || value === undefined) return;
                obj[property] /= value;
            })
        } else {
            if (value === null || value === undefined) return;
            obj[property] /= value;
        }
    },
    set_state: function set_state({ $data, key, prop, value }) {
        const [obj, property] = this.drill($data, key, prop);
        if (value?.$FETCH instanceof Function) {
            return value.$FETCH()
                .then(value => {
                    obj[property] = value === null ? null : value === undefined ? undefined : value;
                })
        } else if (value instanceof Promise) {
            return value.then(value => {
                obj[property] = value === null ? null : value === undefined ? undefined : value;
            })
        } else {
            obj[property] = value === null ? null : value === undefined ? undefined : value;
        }
    },
    coalesce_w_state: function set_state({ $data, key, prop, value }) {
        if (!value) return;
        const [obj, property] = this.drill($data, key, prop);
        if (value?.$FETCH instanceof Function) {
            return value.$FETCH()
                .then(value => {
                    if (value === null || value === undefined) return;
                    obj[property] = value;
                })
        } else if (value instanceof Promise) {
            return value.then(value => {
                if (value === null || value === undefined) return;
                obj[property] = value;
            })
        } else {
            obj[property] = value;
        }
    }
}