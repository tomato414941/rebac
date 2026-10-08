// Runs a generator-based walk: each yielded value is rows (or a promise of rows) to await, and the generator's
// return is the answer. Stays synchronous as long as nothing yielded is a promise.
const isPromise = value => value && typeof value.then === 'function';

export function drive(generator) {
  let step = generator.next();
  while (!step.done) {
    const value = step.value;
    if (isPromise(value)) return value.then(async resolved => {
      let next = generator.next(resolved);
      while (!next.done) next = generator.next(await next.value);
      return next.value;
    });
    step = generator.next(value);
  }
  return step.value;
}

// Applies f to an answer that may or may not have arrived yet, keeping it synchronous when it already has.
export const then = (value, f) => isPromise(value) ? value.then(f) : f(value);
