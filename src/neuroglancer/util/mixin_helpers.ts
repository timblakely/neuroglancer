export type Constructor<T> = new (...args: any[]) => T;

export type ConstructorWithMixin<Base, Mixin> = Base&Constructor<Mixin>;
