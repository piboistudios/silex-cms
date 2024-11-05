export const ACTIONS_JS = {
    run_all: function run_all(...fns: Function[]) {
        while (fns.length) {
            const fn = fns.shift()!;
            const v = fn();
            if (v instanceof Promise) {
                return v.then(() => {
                    return run_all(...fns)
                })
            }
        }
    },
    set_state: function set_state(opts) {
        const { $data, key, value } = opts;
        if (value.$FETCH instanceof Function) {
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
        if (value.$FETCH instanceof Function) {
            return value.$FETCH()
                .then(value => {
                    if (!value) return;
                    $data[key] = value === null ? null : value === undefined ? undefined : value.filtered().valueOf();
                })
        } else if (value instanceof Promise) {
            return value.then(value => {
                if (!value) return;
                $data[key] = value === null ? null : value === undefined ? undefined : value.filtered().valueOf();
            })
        } else {
            $data[key] = value === null ? null : value === undefined ? undefined : value.filtered().valueOf();
        }
    }
}