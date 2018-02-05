/**
 * @license
 * Copyright 2016 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {Borrowed, Owned, RefCounted} from 'neuroglancer/util/disposable';
import {NullaryReadonlySignal, NullarySignal} from 'neuroglancer/util/signal';
import {Trackable} from 'neuroglancer/util/trackable';

export interface WatchableValueInterface<T> {
  value: T;
  changed: NullaryReadonlySignal;
}

export class WatchableValue<T> implements WatchableValueInterface<T> {
  get value() {
    return this.value_;
  }
  set value(newValue: T) {
    if (newValue !== this.value_) {
      this.value_ = newValue;
      this.changed.dispatch();
    }
  }
  changed = new NullarySignal();
  constructor(protected value_: T) {}
}

export class TrackableValue<T> extends WatchableValue<T> implements Trackable {
  constructor(value: T, public validator: (value: any) => T, public defaultValue = value) {
    super(value);
  }
  toJSON() {
    let {value_} = this;
    if (value_ === this.defaultValue) {
      return undefined;
    }
    return this.value_;
  }
  reset() {
    this.value = this.defaultValue;
  }
  restoreState(x: any) {
    if (x !== undefined) {
      let {validator} = this;
      try {
        this.value = validator(x);
        return;
      } catch (ignoredError) {
      }
    }
    this.value = this.defaultValue;
  }
}

class DerivedWatchableValue<U> extends RefCounted implements WatchableValueInterface<U> {
  changed = new NullarySignal();
  get value() {
    return this.f(...this.ws.map(w => w.value));
  }
  private f: (...v: any[]) => U;
  private ws: WatchableValueInterface<any>[];

  constructor(f: (...v: any[]) => U, ws: WatchableValueInterface<any>[]) {
    super();
    this.f = f;
    this.ws = ws;
    for (const w of ws) {
      this.registerDisposer(w.changed.add(this.changed.dispatch));
    }
  }
}

export function makeDerivedWatchableValue<U, T0>(
    f: (v0: T0) => U, w0: WatchableValueInterface<T0>): DerivedWatchableValue<U>;
export function makeDerivedWatchableValue<U, T0, T1>(
    f: (v0: T0, v1: T1) => U, w0: WatchableValueInterface<T0>,
    w1: WatchableValueInterface<T1>): DerivedWatchableValue<U>;
export function makeDerivedWatchableValue<U>(
    f: (...v: any[]) => U, ...ws: WatchableValueInterface<any>[]) {
  return new DerivedWatchableValue(f, ws);
}

export class ComputedWatchableValue<U> extends RefCounted implements WatchableValueInterface<U> {
  get value() {
    return this.f();
  }
  changed = new NullarySignal();
  constructor(public f: () => U, ...signals: NullarySignal[]) {
    super();
    for (const signal of signals) {
      this.registerDisposer(signal.add(this.changed.dispatch));
    }
  }
}

export class WatchableRefCounted<T extends RefCounted> extends RefCounted implements
    WatchableValueInterface<T|undefined> {
  changed = new NullarySignal();

  private value_: Owned<T>|undefined;
  private valueHandler: (() => void)|undefined;

  get value(): Borrowed<T>|undefined {
    return this.value_;
  }

  set value(value: Owned<T>|undefined) {
    const {value_} = this;
    this.value_ = value;
    if (value_ !== undefined) {
      value_.dispose();
      this.valueHandler = undefined;
    }
    if (value !== undefined) {
      const valueHandler = this.valueHandler = () => {
        if (this.value_ === value) {
          this.value_ = undefined;
          this.changed.dispatch();
        }
      };
      value.registerDisposer(valueHandler);
    }

    if (value !== value_) {
      this.changed.dispatch();
    }
  }

  reset() {
    this.value = undefined;
  }

  disposed() {
    if (this.value_ !== undefined) {
      this.value_.dispose();
    }
    this.value_ = undefined;
    super.disposed();
  }
}


export interface TrackableValueInterface<T> extends WatchableValueInterface<T>, Trackable {}

export class TrackableRefCounted<T extends RefCounted> extends WatchableRefCounted<T> implements
    TrackableValueInterface<T|undefined> {
  constructor(
      public validator: (value: any) => T | undefined, public jsonConverter: (value: T) => any) {
    super();
  }
  toJSON() {
    const {value} = this;
    return value && this.jsonConverter(value);
  }

  restoreState(x: any) {
    this.value = this.validator(x);
  }
}
