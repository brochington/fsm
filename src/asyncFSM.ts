import EventEmitter from 'eventemitter3';
import { isFunction, isObject, isUndefined } from 'lodash';
import {
  isIterable,
  isAsyncIterable,
  isGeneratorFunction,
  isAsyncGeneratorFunction,
  isPromise,
} from 'utils';

type NoInfer<T> = [T][T extends any ? 0 : never];

export type DataSetterFunc<D> = (currentData: D | undefined) => D;
export type DataFunc<D> = (nextData?: D | DataSetterFunc<D>) => D | undefined;

// Transition Functions
export type TransitionResult =
  | void
  | Promise<void>
  | Generator
  | AsyncGenerator;

export type TransitionFuncArgs<S extends string, D> = {
  data: DataFunc<D>;
  current: S;
  next: (nextState: S) => void;
  complete: () => void;
  from: any;
  emit: <P>(eventName: string, payload?: P) => void;
};

export type TransitionFunc<S extends string, D> = {
  (args: TransitionFuncArgs<S, D>): TransitionResult;
};

export type StateObj<S extends string, D> = {
  enter?: EnterFunc<S, D>;
  on?: TransitionFunc<S, D>;
  exit?: ExitFunc<S, D>;
  // next?: S, // TODO!!
  final?: boolean,
};

export function isStateObj<S extends string, D>(
  maybeStateObj: any
): maybeStateObj is StateObj<S, D> {
  return typeof maybeStateObj === 'object';
}

export type States<S extends string, D> = {
  [key in S]: StateObj<S, D> | TransitionFunc<S, D> | { next: S }
};

// Exit Functions
export type ExitFuncArgs<S extends string, D> = {
  data: DataFunc<D>;
  previousState: S;
  nextState: S;
};

export type ExitFunc<S extends string, D> = (
  args: ExitFuncArgs<S, D>
) => TransitionResult;

export type ExitEvents<S extends string, D> = {
  [key in S]?: ExitFunc<S, D>;
};

export function isExitFunc<S extends string, D>(
  maybeExitFunc: any
): maybeExitFunc is EnterFunc<S, D> {
  return maybeExitFunc && isFunction(maybeExitFunc);
}

// Enter Functions
export type EnterFuncArgs<S extends string, D> = {
  data: DataFunc<D>;
  previousState: S;
  nextState: S;
};

export type EnterFunc<S extends string, D> = (
  args: EnterFuncArgs<S, D>
) => TransitionResult;

export type EnterEvents<S extends string, D> = {
  [key in S]?: EnterFunc<S, D>;
};

export function isEnterFunc<S extends string, D>(
  maybeEnterFunc: any
): maybeEnterFunc is EnterFunc<S, D> {
  return maybeEnterFunc && isFunction(maybeEnterFunc);
}

export type FSMConfig<S extends string, D> = {
  initial: NoInfer<S>;
  data?: D;
  states: States<S, D>;
  enter?: EnterEvents<S, D>;
  exit?: ExitEvents<S, D>;
};

export type InnerStates = 'idle' | 'transitioning';

// Guard Functions
export function isTransitionFunc<S extends string, D>(
  maybeFunc: any
): maybeFunc is TransitionFunc<S, D> {
  return typeof maybeFunc === 'function';
}

export default class AsyncFSM<S extends string, D = unknown> extends EventEmitter {
  private _current: S;
  private _complete: boolean = false;
  private _innerState: InnerStates = 'idle';

  inital: S;

  private _data: D | undefined;

  private _states: States<S, D>;

  _config: FSMConfig<S, D>;

  // Static helper methods

  constructor(config: FSMConfig<S, D>) {
    super();

    this.inital = config.initial;
    this._current = config.initial;
    this._states = config.states;
    this._config = config;
    this._data = config.data;
  }

  get current(): S {
    return this._current;
  }

  get complete(): boolean {
    return this._complete;
  }

  get data(): D | undefined {
    return this._data;
  }

  async next(nextData?: D | DataSetterFunc<D>) {
    if (arguments.length > 0) {
      await this._setData(nextData);
    }

    if (this._innerState === 'idle') {
      await this._runCurrentTransition();
    } else {
      console.error('Unable to transition when not in an idle state.');
      // maybe send some kind of event like "onidle"?
    }
  }

  private async _runCurrentTransition() {
    this._innerState = 'transitioning';
    const currentState = this._states[this._current];
    const transitionArgs = {
      current: this._current,
      next: (nextState: S) => {
        if (this._complete) return;
        
        this._current = nextState;
        
        const currentState = this._states[this._current];

        if (isStateObj(currentState) && currentState.final) {
          this._complete = true;
        }
      },
      data: this._setData.bind(this),
      emit: <P>(event: string, payload?: P) => {
        this.emit('emit', { event, payload });
      },
      from: () => {}, // unimplemented!
      complete: () => {
        this._complete = true;
      }
    };

    let result;
    const preOnState = this._current;

    // Just the function
    if (isTransitionFunc<S, D>(currentState)) {
      result = currentState(transitionArgs);
    }

    // the whole object.
    if (isStateObj<S, D>(currentState) && currentState.on) {
      result = currentState.on(transitionArgs);
    }

    await this._handleTransitionResult(result);

    // NOTE: For now both the exit and enter calls happen AFTER
    //       the "on" call, due to async ordering issues.
    //       Not sure if this will stay like this.
    if (this._current !== preOnState) {
      await this._runExit(preOnState, this._current);
      await this._runEnter(preOnState, this._current);
    }

    this._innerState = 'idle';
  }

  private async _runExit(prevStateKey: S, nextStateKey: S) {
    const currentState = this._states[prevStateKey];

    if (isStateObj<S, D>(currentState)) {
      if (isExitFunc(currentState.exit)) {
        const result = currentState.exit({
          data: this._setData.bind(this),
          previousState: prevStateKey,
          nextState: nextStateKey,
        });

        await this._handleTransitionResult(result);
      }
    }
  }

  private async _runEnter(prevStateKey: S, nextStateKey: S) {
    const nextState = this._states[this._current];

    if (isStateObj<S, D>(nextState)) {
      if (isEnterFunc(nextState.enter)) {
        const result = nextState.enter({
          data: this._setData.bind(this),
          previousState: prevStateKey,
          nextState: nextStateKey,
        });

        await this._handleTransitionResult(result);
      }
    }
  }

  private _setData(nextData?: D | DataSetterFunc<D>): D | undefined {
    // no nextData is set.
    if (arguments.length === 0) {
      return this._data;
    }

    this._data = isFunction(nextData) ? nextData(this._data) : nextData;

    return this._data;
  }

  private async _handleTransitionResult(result: TransitionResult) {
    // console.log('result!', result);
    if (!result) {
      return;
    }

    if (isPromise(result)) {
      try {
        await result;
      } catch (err) {
        console.error('_handleTransitionResult', err);
      }
    } else if (isGeneratorFunction(result)) {
      for (const g of result) {
        // Question: What should I do here, if anything?
      }
    } else if (isAsyncGeneratorFunction(result)) {
      for await (const g of result) {
        // Question: What should I do here, if anything?
      }
    }
  }

  reset(): void {
    this._current = this.inital;
  }

  // maybe rename this to peek?
  check(checkState: S): boolean {
    return this.current === checkState;
  }

  watch<SS extends string, DD>(fsmToMonitor: AsyncFSM<SS, DD>) {
    fsmToMonitor.on('emit', ({ event, payload }) => {
      console.log('emitt!!!!!!', event, payload);
    });

    // TODO: Add an destroy event that removes event handlers when child is destroyed.

    return this;
  }
}
