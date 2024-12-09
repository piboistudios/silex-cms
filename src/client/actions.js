export const ACTIONS_JS = {
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
        key
    }) {
        $data[key] = !$data[key];
    },
    flag_state: function flag_state({
        $data,
        key
    }) {
        $data[key] = true;
    },
    unflag_state: function unflag_state({
        $data,
        key
    }) {
        $data[key] = false;
    },
    subtract_from_state: function subtract_from_state({
        $data,
        key,
        value
    }) {
        if (value?.$FETCH instanceof Function) {
            return value.$FETCH()
                .then(value => {
                    if (value === null || value === undefined) return;
                    $data[key] -= value.filtered().valueOf();
                })
        } else if (value instanceof Promise) {
            return value.then(value => {
                if (value === null || value === undefined) return;
                $data[key] -= value.filtered().valueOf();
            })
        } else {
            if (value === null || value === undefined) return;
            $data[key] -= value.filtered().valueOf();
        }
    },
    add_to_state: function add_to_state({
        $data,
        key,
        value
    }) {
        if (value?.$FETCH instanceof Function) {
            return value.$FETCH()
                .then(value => {
                    if (value === null || value === undefined) return;
                    $data[key] += value.filtered().valueOf();
                })
        } else if (value instanceof Promise) {
            return value.then(value => {
                if (value === null || value === undefined) return;
                $data[key] += value.filtered().valueOf();
            })
        } else {
            if (value === null || value === undefined) return;
            $data[key] += value.filtered().valueOf();
        }
    },
    prepend_to_state: function prepend_to_state({
        $data,
        key,
        value
    }) {
        if (value?.$FETCH instanceof Function) {
            return value.$FETCH()
                .then(value => {
                    if (value === null || value === undefined) return;
                    $data[key] = value.filtered().valueOf() + $data[key];
                })
        } else if (value instanceof Promise) {
            return value.then(value => {
                if (value === null || value === undefined) return;
                $data[key] = value.filtered().valueOf() + $data[key];
            })
        } else {
            if (value === null || value === undefined) return;
            $data[key] = value.filtered().valueOf() + $data[key];
        }
    },
    multiply_state: function multiply_state({
        $data,
        key,
        value
    }) {
        if (value?.$FETCH instanceof Function) {
            return value.$FETCH()
                .then(value => {
                    if (value === null || value === undefined) return;
                    $data[key] *= value.filtered().valueOf();
                })
        } else if (value instanceof Promise) {
            return value.then(value => {
                if (value === null || value === undefined) return;
                $data[key] *= value.filtered().valueOf();
            })
        } else {
            if (value === null || value === undefined) return;
            $data[key] *= value.filtered().valueOf();
        }
    },
    divide_state: function divide_state({
        $data,
        key,
        value
    }) {
        if (value?.$FETCH instanceof Function) {
            return value.$FETCH()
                .then(value => {
                    if (value === null || value === undefined) return;
                    $data[key] /= value.filtered().valueOf();
                })
        } else if (value instanceof Promise) {
            return value.then(value => {
                if (value === null || value === undefined) return;
                $data[key] /= value.filtered().valueOf();
            })
        } else {
            if (value === null || value === undefined) return;
            $data[key] /= value.filtered().valueOf();
        }
    },
    set_state: function set_state(opts) {
        const { $data, key, value } = opts;
        if (value?.$FETCH instanceof Function) {
            return value.$FETCH()
                .then(value => {
                    $data[key] = value === null ? null : value === undefined ? undefined : value.filtered().valueOf();
                })
        } else if (value instanceof Promise) {
            return value.then(value => {
                $data[key] = value === null ? null : value === undefined ? undefined : value.filtered().valueOf();
            })
        } else {
            $data[key] = value === null ? null : value === undefined ? undefined : value.filtered().valueOf();
        }
    },
    coalesce_w_state: function set_state(opts) {
        const { $data, key, value } = opts;
        if (!value) return;
        if (value?.$FETCH instanceof Function) {
            return value.$FETCH()
                .then(value => {
                    if (value === null || value === undefined) return;
                    $data[key] = value.filtered().valueOf();
                })
        } else if (value instanceof Promise) {
            return value.then(value => {
                if (value === null || value === undefined) return;
                $data[key] = value.filtered().valueOf();
            })
        } else {
            $data[key] = value.filtered().valueOf();
        }
    }
}