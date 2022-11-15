/* eslint-disable max-lines */
import { Hub } from '@sentry/core';
import { EventProcessor, Integration, Transaction, TransactionContext, TransactionSource } from '@sentry/types';
import { baggageHeaderToDynamicSamplingContext, getDomElement, logger } from '@sentry/utils';

import { startIdleTransaction } from '../hubextensions';
import {
  DEFAULT_FINAL_TIMEOUT,
  DEFAULT_HEARTBEAT_INTERVAL,
  DEFAULT_IDLE_TIMEOUT,
  IdleTransaction,
} from '../idletransaction';
import { extractTraceparentData } from '../utils';
import { registerBackgroundTabDetection } from './backgroundtab';
import { addPerformanceEntries, startTrackingLongTasks, startTrackingWebVitals } from './metrics';
import {
  defaultRequestInstrumentationOptions,
  instrumentOutgoingRequests,
  RequestInstrumentationOptions,
} from './request';
import { instrumentRoutingWithDefaults } from './router';
import { WINDOW } from './types';

export const BROWSER_TRACING_INTEGRATION_ID = 'BrowserTracing';

/** Options for Browser Tracing integration */
export interface BrowserTracingOptions extends RequestInstrumentationOptions {
  /**
   * The time to wait in ms until the transaction will be finished during an idle state. An idle state is defined
   * by a moment where there are no in-progress spans.
   *
   * The transaction will use the end timestamp of the last finished span as the endtime for the transaction.
   * If there are still active spans when this the `idleTimeout` is set, the `idleTimeout` will get reset.
   * Time is in ms.
   *
   * Default: 1000
   */
  idleTimeout: number;

  /**
   * The max duration for a transaction. If a transaction duration hits the `finalTimeout` value, it
   * will be finished.
   * Time is in ms.
   *
   * Default: 30000
   */
  finalTimeout: number;

  /**
   * The heartbeat interval. If no new spans are started or open spans are finished within 3 heartbeats,
   * the transaction will be finished.
   * Time is in ms.
   *
   * Default: 5000
   */
  heartbeatInterval: number;

  /**
   * Flag to enable/disable creation of `navigation` transaction on history changes.
   *
   * Default: true
   */
  startTransactionOnLocationChange: boolean;

  /**
   * Flag to enable/disable creation of `pageload` transaction on first pageload.
   *
   * Default: true
   */
  startTransactionOnPageLoad: boolean;

  /**
   * Flag Transactions where tabs moved to background with "cancelled". Browser background tab timing is
   * not suited towards doing precise measurements of operations. By default, we recommend that this option
   * be enabled as background transactions can mess up your statistics in nondeterministic ways.
   *
   * Default: true
   */
  markBackgroundTransactions: boolean;

  /**
   * _metricOptions allows the user to send options to change how metrics are collected.
   *
   * _metricOptions is currently experimental.
   *
   * Default: undefined
   */
  _metricOptions?: Partial<{ _reportAllChanges: boolean }>;

  /**
   * _experiments allows the user to send options to define how this integration works.
   *
   * Default: undefined
   */
  _experiments?: Partial<{ enableLongTask: boolean; interactionSampleRate: number }>;

  /**
   * beforeNavigate is called before a pageload/navigation transaction is created and allows users to modify transaction
   * context data, or drop the transaction entirely (by setting `sampled = false` in the context).
   *
   * Note: For legacy reasons, transactions can also be dropped by returning `undefined`.
   *
   * @param context: The context data which will be passed to `startTransaction` by default
   *
   * @returns A (potentially) modified context object, with `sampled = false` if the transaction should be dropped.
   */
  beforeNavigate?(context: TransactionContext): TransactionContext | undefined;

  /**
   * Instrumentation that creates routing change transactions. By default creates
   * pageload and navigation transactions.
   */
  routingInstrumentation<T extends Transaction>(
    customStartTransaction: (context: TransactionContext) => T | undefined,
    startTransactionOnPageLoad?: boolean,
    startTransactionOnLocationChange?: boolean,
  ): void;
}

const DEFAULT_BROWSER_TRACING_OPTIONS = {
  idleTimeout: DEFAULT_IDLE_TIMEOUT,
  finalTimeout: DEFAULT_FINAL_TIMEOUT,
  heartbeatInterval: DEFAULT_HEARTBEAT_INTERVAL,
  markBackgroundTransactions: true,
  routingInstrumentation: instrumentRoutingWithDefaults,
  startTransactionOnLocationChange: true,
  startTransactionOnPageLoad: true,
  _experiments: { enableLongTask: true, interactionSampleRate: 0.0 },
  ...defaultRequestInstrumentationOptions,
};

/**
 * The Browser Tracing integration automatically instruments browser pageload/navigation
 * actions as transactions, and captures requests, metrics and errors as spans.
 *
 * The integration can be configured with a variety of options, and can be extended to use
 * any routing library. This integration uses {@see IdleTransaction} to create transactions.
 */
export class BrowserTracing implements Integration {
  // This class currently doesn't have a static `id` field like the other integration classes, because it prevented
  // @sentry/tracing from being treeshaken. Tree shakers do not like static fields, because they behave like side effects.
  // TODO: Come up with a better plan, than using static fields on integration classes, and use that plan on all
  // integrations.

  /** Browser Tracing integration options */
  public options: BrowserTracingOptions;

  /**
   * @inheritDoc
   */
  public name: string = BROWSER_TRACING_INTEGRATION_ID;

  private _getCurrentHub?: () => Hub;

  private _latestRouteName?: string;
  private _latestRouteSource?: TransactionSource;

  public constructor(_options?: Partial<BrowserTracingOptions>) {
    this.options = {
      ...DEFAULT_BROWSER_TRACING_OPTIONS,
      ..._options,
    };

    const { _metricOptions } = this.options;
    startTrackingWebVitals(_metricOptions && _metricOptions._reportAllChanges);
    if (this.options._experiments?.enableLongTask) {
      startTrackingLongTasks();
    }
  }

  /**
   * @inheritDoc
   */
  public setupOnce(_: (callback: EventProcessor) => void, getCurrentHub: () => Hub): void {
    this._getCurrentHub = getCurrentHub;

    // eslint-disable-next-line @typescript-eslint/unbound-method
    const {
      routingInstrumentation: instrumentRouting,
      startTransactionOnLocationChange,
      startTransactionOnPageLoad,
      markBackgroundTransactions,
      traceFetch,
      traceXHR,
      // eslint-disable-next-line deprecation/deprecation
      tracingOrigins,
      shouldCreateSpanForRequest,
      _experiments,
    } = this.options;

    instrumentRouting(
      (context: TransactionContext) => this._createRouteTransaction(context),
      startTransactionOnPageLoad,
      startTransactionOnLocationChange,
    );

    if (markBackgroundTransactions) {
      registerBackgroundTabDetection();
    }

    if (_experiments?.interactionSampleRate ?? 0 > 0) {
      this._registerInteractionListener(_experiments?.interactionSampleRate ?? 0);
    }

    instrumentOutgoingRequests({ traceFetch, traceXHR, tracingOrigins, shouldCreateSpanForRequest });
  }

  /** Create routing idle transaction. */
  private _createRouteTransaction(context: TransactionContext): Transaction | undefined {
    if (!this._getCurrentHub) {
      __DEBUG_BUILD__ &&
        logger.warn(`[Tracing] Did not create ${context.op} transaction because _getCurrentHub is invalid.`);
      return undefined;
    }

    // eslint-disable-next-line @typescript-eslint/unbound-method
    const { beforeNavigate, idleTimeout, finalTimeout, heartbeatInterval } = this.options;

    const isPageloadTransaction = context.op === 'pageload';

    const sentryTraceMetaTagValue = isPageloadTransaction ? getMetaContent('sentry-trace') : null;
    const baggageMetaTagValue = isPageloadTransaction ? getMetaContent('baggage') : null;

    const traceParentData = sentryTraceMetaTagValue ? extractTraceparentData(sentryTraceMetaTagValue) : undefined;
    const dynamicSamplingContext = baggageMetaTagValue
      ? baggageHeaderToDynamicSamplingContext(baggageMetaTagValue)
      : undefined;

    const expandedContext: TransactionContext = {
      ...context,
      ...traceParentData,
      metadata: {
        ...context.metadata,
        dynamicSamplingContext: traceParentData && !dynamicSamplingContext ? {} : dynamicSamplingContext,
      },
      trimEnd: true,
    };

    const modifiedContext = typeof beforeNavigate === 'function' ? beforeNavigate(expandedContext) : expandedContext;

    // For backwards compatibility reasons, beforeNavigate can return undefined to "drop" the transaction (prevent it
    // from being sent to Sentry).
    const finalContext = modifiedContext === undefined ? { ...expandedContext, sampled: false } : modifiedContext;

    // If `beforeNavigate` set a custom name, record that fact
    finalContext.metadata =
      finalContext.name !== expandedContext.name
        ? { ...finalContext.metadata, source: 'custom' }
        : finalContext.metadata;

    this._latestRouteName = finalContext.name;
    this._latestRouteSource = finalContext.metadata?.source;

    if (finalContext.sampled === false) {
      __DEBUG_BUILD__ &&
        logger.log(`[Tracing] Will not send ${finalContext.op} transaction because of beforeNavigate.`);
    }

    __DEBUG_BUILD__ && logger.log(`[Tracing] Starting ${finalContext.op} transaction on scope`);

    const hub = this._getCurrentHub();
    const { location } = WINDOW;

    const idleTransaction = startIdleTransaction(
      hub,
      finalContext,
      idleTimeout,
      finalTimeout,
      true,
      { location }, // for use in the tracesSampler
      heartbeatInterval,
    );
    idleTransaction.registerBeforeFinishCallback(transaction => {
      addPerformanceEntries(transaction);
      transaction.setTag(
        'sentry_reportAllChanges',
        Boolean(this.options._metricOptions && this.options._metricOptions._reportAllChanges),
      );
    });

    return idleTransaction as Transaction;
  }

  /** Start listener for interaction transactions */
  private _registerInteractionListener(interactionSampleRate: number): void {
    let inflightInteractionTransaction: IdleTransaction | undefined;
    const registerInteractionTransaction = (): void => {
      const { idleTimeout, finalTimeout, heartbeatInterval } = this.options;
      if (Math.random() > interactionSampleRate) {
        return;
      }

      const op = 'ui.action.click';
      if (inflightInteractionTransaction) {
        inflightInteractionTransaction.finish();
        inflightInteractionTransaction = undefined;
      }

      if (!this._getCurrentHub) {
        __DEBUG_BUILD__ && logger.warn(`[Tracing] Did not create ${op} transaction because _getCurrentHub is invalid.`);
        return undefined;
      }

      if (!this._latestRouteName) {
        __DEBUG_BUILD__ &&
          logger.warn(`[Tracing] Did not create ${op} transaction because _latestRouteName is missing.`);
        return undefined;
      }

      const hub = this._getCurrentHub();
      const { location } = WINDOW;

      const context: TransactionContext = {
        name: this._latestRouteName,
        op,
        trimEnd: true,
        metadata: {
          source: this._latestRouteSource ?? 'url',
        },
      };

      inflightInteractionTransaction = startIdleTransaction(
        hub,
        context,
        idleTimeout,
        finalTimeout,
        true,
        { location }, // for use in the tracesSampler
        heartbeatInterval,
      );
    };

    ['click'].forEach(type => {
      addEventListener(type, registerInteractionTransaction, { once: false, capture: true });
    });
  }
}

/** Returns the value of a meta tag */
export function getMetaContent(metaName: string): string | null {
  // Can't specify generic to `getDomElement` because tracing can be used
  // in a variety of environments, have to disable `no-unsafe-member-access`
  // as a result.
  const metaTag = getDomElement(`meta[name=${metaName}]`);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  return metaTag ? metaTag.getAttribute('content') : null;
}
