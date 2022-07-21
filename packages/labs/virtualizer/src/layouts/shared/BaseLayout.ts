/**
 * @license
 * Copyright 2021 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import EventTarget from '../../polyfillLoaders/EventTarget.js';
import {ScrollElementIntoViewOptions} from '../../Virtualizer.js';
import {
  Layout,
  ChildPositions,
  Positions,
  ScrollDirection,
  Size,
  dimension,
  position,
  PinnedItem,
} from './Layout.js';

type UpdateVisibleIndicesOptions = {
  emit?: boolean;
};

export interface BaseLayoutConfig {
  direction?: ScrollDirection;
}

export function dim1(direction: ScrollDirection): dimension {
  return direction === 'horizontal' ? 'width' : 'height';
}

export function dim2(direction: ScrollDirection): dimension {
  return direction === 'horizontal' ? 'height' : 'width';
}

export function pos1(direction: ScrollDirection): position {
  return direction === 'horizontal' ? 'left' : 'top';
}

export function pos2(direction: ScrollDirection): position {
  return direction === 'horizontal' ? 'top' : 'left';
}

export abstract class BaseLayout<C extends BaseLayoutConfig> implements Layout {
  /**
   * The last set viewport scroll position.
   */
  private _latestCoords: Positions = {left: 0, top: 0};

  /**
   * Scrolling direction.
   */
  private _direction: ScrollDirection | null = null;

  /**
   * Dimensions of the viewport.
   */
  private _viewportSize: Size = {width: 0, height: 0};

  /**
   * Flag for debouncing asynchnronous reflow requests.
   */
  private _pendingReflow = false;

  private _pendingLayoutUpdate = false;

  protected _pinnedItem: PinnedItem | null = null;

  protected _pinnedPosition: ScrollToOptions | null = null;

  /**
   * The index of the first item intersecting the viewport.
   */
  protected _firstVisible = 0;

  /**
   * The index of the last item intersecting the viewport.
   */
  protected _lastVisible = 0;

  private _eventTargetPromise: Promise<void> = EventTarget().then((Ctor) => {
    this._eventTarget = new Ctor();
  });

  /**
   * Pixel offset in the scroll direction of the first child.
   */
  protected _physicalMin = 0;

  /**
   * Pixel offset in the scroll direction of the last child.
   */
  protected _physicalMax = 0;

  /**
   * Index of the first child.
   */
  protected _first = -1;

  /**
   * Index of the last child.
   */
  protected _last = -1;

  /**
   * Length in the scrolling direction.
   */
  protected _sizeDim: dimension = 'height';

  /**
   * Length in the non-scrolling direction.
   */
  protected _secondarySizeDim: dimension = 'width';

  /**
   * Position in the scrolling direction.
   */
  protected _positionDim: position = 'top';

  /**
   * Position in the non-scrolling direction.
   */
  protected _secondaryPositionDim: position = 'left';

  /**
   * Current scroll offset in pixels.
   */
  protected _scrollPosition = 0;

  /**
   * Difference between current scroll offset and scroll offset calculated due
   * to a reflow.
   */
  protected _scrollError = 0;

  /**
   * Whether all children in range were in range during the previous reflow.
   */
  protected _stable = true;

  /**
   * Total number of items that could possibly be displayed. Used to help
   * calculate the scroll size.
   */
  protected _totalItems = 0;

  /**
   * The total (estimated) length of all items in the scrolling direction.
   */
  protected _scrollSize = 1;

  /**
   * Number of pixels beyond the viewport to still include
   * in the active range of items.
   */
  // TODO (graynorton): Probably want to make this something we calculate based
  // on viewport size, item size, other factors, possibly still with a dial of some kind
  protected _overhang = 1000;

  private _eventTarget: EventTarget | null = null;

  protected get _defaultConfig(): C {
    return {
      direction: 'vertical',
    } as C;
  }

  constructor(config?: C) {
    // Delay setting config so that subclasses do setup work first
    Promise.resolve().then(() => (this.config = config || this._defaultConfig));
  }

  set config(config: C) {
    Object.assign(this, Object.assign({}, this._defaultConfig, config));
  }

  get config(): C {
    return {
      direction: this.direction,
    } as C;
  }

  /**
   * Maximum index of children + 1, to help estimate total height of the scroll
   * space.
   */
  get totalItems(): number {
    return this._totalItems;
  }
  set totalItems(num) {
    const _num = Number(num);
    if (_num !== this._totalItems) {
      this._totalItems = _num;
      this._scheduleReflow();
    }
  }

  /**
   * Primary scrolling direction.
   */
  get direction(): ScrollDirection {
    return this._direction!;
  }
  set direction(dir) {
    // Force it to be either horizontal or vertical.
    dir = dir === 'horizontal' ? dir : 'vertical';
    if (dir !== this._direction) {
      this._direction = dir;
      this._sizeDim = dir === 'horizontal' ? 'width' : 'height';
      this._secondarySizeDim = dir === 'horizontal' ? 'height' : 'width';
      this._positionDim = dir === 'horizontal' ? 'left' : 'top';
      this._secondaryPositionDim = dir === 'horizontal' ? 'top' : 'left';
      this._triggerReflow();
    }
  }

  /**
   * Height and width of the viewport.
   */
  get viewportSize(): Size {
    return this._viewportSize;
  }
  set viewportSize(dims) {
    const {_viewDim1, _viewDim2} = this;
    Object.assign(this._viewportSize, dims);
    if (_viewDim2 !== this._viewDim2) {
      // this._viewDim2Changed();
      this._scheduleLayoutUpdate();
    } else if (_viewDim1 !== this._viewDim1) {
      this._checkThresholds();
    }
  }

  /**
   * Scroll offset of the viewport.
   */
  get viewportScroll(): Positions {
    return this._latestCoords;
  }
  set viewportScroll(coords) {
    Object.assign(this._latestCoords, coords);
    const oldPos = this._scrollPosition;
    this._scrollPosition = this._latestCoords[this._positionDim];
    const change = Math.abs(oldPos - this._scrollPosition);
    if (change >= 1) {
      this._updateVisibleIndices({emit: true});
    }
    this._checkThresholds();
  }

  /**
   * Perform a reflow if one has been scheduled.
   */
  reflowIfNeeded(force = false) {
    if (force || this._pendingReflow) {
      this._pendingReflow = false;
      this._reflow();
    }
  }

  set pinnedItem(item: PinnedItem | null) {
    this._pinnedItem = item;
    this._scheduleReflow();
  }

  get pinnedItem() {
    if (this._pinnedItem !== null) {
      const {index, block} = this._pinnedItem;
      return {
        index: Math.max(0, Math.min(index, this.totalItems - 1)),
        block,
      };
    }
    return null;
  }

  set pinnedCoordinates(position: ScrollToOptions | null) {
    this._pinnedPosition = position;
    this._scheduleReflow();
  }

  get pinnedCoordinates() {
    if (this._pinnedPosition !== null) {
      const pos = pos1(this.direction);
      if (this._pinnedPosition[pos] !== undefined) {
        return {
          [pos]: Math.max(
            0,
            Math.min(
              this._pinnedPosition[pos]!,
              this._scrollSize - this._viewDim1
            )
          ),
        };
      }
    }
    return null;
  }

  unpin() {
    this._pinnedItem = null;
    this._pinnedPosition = null;
  }

  async dispatchEvent(evt: Event) {
    await this._eventTargetPromise;
    this._eventTarget!.dispatchEvent(evt);
  }

  async addEventListener(
    type: string,
    listener: EventListener | EventListenerObject | null,
    options?: boolean | AddEventListenerOptions | undefined
  ) {
    await this._eventTargetPromise;
    this._eventTarget!.addEventListener(type, listener, options);
  }

  async removeEventListener(
    type: string,
    callback: EventListener | EventListenerObject | null,
    options?: boolean | EventListenerOptions | undefined
  ) {
    await this._eventTargetPromise;
    this._eventTarget!.removeEventListener(type, callback, options);
  }

  /**
   * Get the top and left positioning of the item at idx.
   */
  protected abstract _getItemPosition(idx: number): Positions;

  /**
   * Update _first and _last based on items that should be in the current
   * range.
   */
  protected abstract _getActiveItems(): void;

  protected abstract _getItemSize(_idx: number): Size;

  /**
   * Calculates (precisely or by estimating, if needed) the total length of all items in
   * the scrolling direction, including spacing, caching the value in the `_scrollSize` field.
   *
   * Should return a minimum value of 1 to ensure at least one item is rendered.
   * TODO (graynorton): Possibly no longer required, but leaving here until it can be verified.
   */
  protected abstract _updateScrollSize(): void;

  protected _updateLayout(): void {
    // Override
  }

  // protected _viewDim2Changed(): void {
  //   this._scheduleLayoutUpdate();
  // }

  /**
   * The height or width of the viewport, whichever corresponds to the scrolling direction.
   */
  protected get _viewDim1(): number {
    return this._viewportSize[this._sizeDim];
  }

  /**
   * The height or width of the viewport, whichever does NOT correspond to the scrolling direction.
   */
  protected get _viewDim2(): number {
    return this._viewportSize[this._secondarySizeDim];
  }

  protected _scheduleReflow() {
    this._pendingReflow = true;
  }

  protected _scheduleLayoutUpdate() {
    this._pendingLayoutUpdate = true;
    this._scheduleReflow();
  }

  // For triggering a reflow based on incoming changes to
  // the layout config.
  protected _triggerReflow() {
    this._scheduleLayoutUpdate();
    // TODO graynorton@: reflowIfNeeded() isn't really supposed
    // to be called internally. Address in larger cleanup
    // of virtualizer / layout interaction pattern.
    // this.reflowIfNeeded(true);
    Promise.resolve().then(() => this.reflowIfNeeded());
  }

  protected _reflow() {
    if (this._pendingLayoutUpdate) {
      this._updateLayout();
      this._pendingLayoutUpdate = false;
    }
    this._updateScrollSize();
    this._setPositionFromPin();
    this._getActiveItems();
    this._updateVisibleIndices();
    this._emitScrollSize();
    this._emitRange();
    this._emitChildPositions();
    this._emitScrollError();
  }

  /**
   * If we are supposed to be pinned to a particular
   * item or set of coordinates, we set `_scrollPosition`
   * accordingly and adjust `_scrollError` as needed
   * so that the virtualizer can keep the scroll
   * position in the DOM in sync
   */
  protected _setPositionFromPin() {
    if (this.pinnedItem !== null) {
      const {_scrollPosition} = this;
      const {index, block} = this.pinnedItem;
      this._scrollPosition = this._calculateScrollIntoViewPosition({
        index,
        block: block || 'start',
      });
      this._scrollError += _scrollPosition - this._scrollPosition;
    } else if (this.pinnedCoordinates !== null) {
      const {_scrollPosition} = this;
      this._scrollPosition = this.pinnedCoordinates[pos1(this.direction)]!;
      this._scrollError += _scrollPosition - this._scrollPosition;
    }
  }
  /**
   * Calculate the coordinates to scroll to, given
   * a request to scroll to the element at a specific
   * index.
   *
   * Supports the same positioning options (`start`,
   * `center`, `end`, `nearest`) as the standard
   * `Element.scrollIntoView()` method, but currently
   * only considers the provided value in the `block`
   * dimension, since we don't yet have any layouts
   * that support virtualization in two dimensions.
   */
  protected _calculateScrollIntoViewPosition(
    options: ScrollElementIntoViewOptions
  ) {
    const {block} = options;
    const index = Math.min(this.totalItems, Math.max(0, options.index));
    const itemStartPosition = this._getItemPosition(index)[this._positionDim];
    let scrollPosition = itemStartPosition;
    if (block !== 'start') {
      const itemSize = this._getItemSize(index)[this._sizeDim];
      if (block === 'center') {
        scrollPosition =
          itemStartPosition - 0.5 * this._viewDim1 + 0.5 * itemSize;
      } else {
        const itemEndPosition = itemStartPosition - this._viewDim1 + itemSize;
        if (block === 'end') {
          scrollPosition = itemEndPosition;
        } else {
          // block === 'nearest'
          const currentScrollPosition = this._scrollPosition;
          scrollPosition =
            Math.abs(currentScrollPosition - itemStartPosition) <
            Math.abs(currentScrollPosition - itemEndPosition)
              ? itemStartPosition
              : itemEndPosition;
        }
      }
    }
    return Math.floor(scrollPosition);
  }

  public getScrollIntoViewCoordinates(
    options: ScrollElementIntoViewOptions
  ): ScrollToOptions {
    return {
      [this._positionDim as position]:
        this._calculateScrollIntoViewPosition(options),
    } as ScrollToOptions;
  }

  protected _emitRange(inProps: unknown = undefined) {
    const detail = Object.assign(
      {
        first: this._first,
        last: this._last,
        num: this._num,
        firstVisible: this._firstVisible,
        lastVisible: this._lastVisible,
      },
      inProps
    );
    this.dispatchEvent(new CustomEvent('rangechange', {detail}));
  }

  protected _emitScrollSize() {
    const detail = {
      [this._sizeDim]: this._scrollSize,
      [this._secondarySizeDim]: null,
    };
    this.dispatchEvent(new CustomEvent('scrollsizechange', {detail}));
  }

  protected _emitScrollError() {
    if (this._scrollError) {
      const detail = {
        [this._positionDim]: this._scrollError,
        [this._secondaryPositionDim]: 0,
      };
      this.dispatchEvent(new CustomEvent('scrollerrorchange', {detail}));
      this._scrollError = 0;
    }
  }

  /**
   * Get or estimate the top and left positions of items in the current range.
   * Emit an itempositionchange event with these positions.
   */
  protected _emitChildPositions() {
    const detail: ChildPositions = new Map();
    for (let idx = this._first; idx <= this._last; idx++) {
      detail.set(idx, this._getItemPosition(idx));
    }
    this.dispatchEvent(new CustomEvent('itempositionchange', {detail}));
  }

  /**
   * Number of items to display.
   */
  private get _num(): number {
    if (this._first === -1 || this._last === -1) {
      return 0;
    }
    return this._last - this._first + 1;
  }

  private _checkThresholds() {
    if (this._viewDim1 === 0 && this._num > 0) {
      this._scheduleReflow();
    } else {
      const min = Math.max(0, this._scrollPosition - this._overhang);
      const max = Math.min(
        this._scrollSize,
        this._scrollPosition + this._viewDim1 + this._overhang
      );
      if (this._physicalMin > min || this._physicalMax < max) {
        this._scheduleReflow();
      }
    }
  }

  /**
   * Find the indices of the first and last items to intersect the viewport.
   * Emit a visibleindiceschange event when either index changes.
   */
  protected _updateVisibleIndices(options?: UpdateVisibleIndicesOptions) {
    if (this._first === -1 || this._last === -1) return;

    let firstVisible = this._first;
    while (
      firstVisible < this._last &&
      Math.round(
        this._getItemPosition(firstVisible)[this._positionDim] +
          this._getItemSize(firstVisible)[this._sizeDim]
      ) <= Math.round(this._scrollPosition)
    ) {
      firstVisible++;
    }

    let lastVisible = this._last;
    while (
      lastVisible > this._first &&
      Math.round(this._getItemPosition(lastVisible)[this._positionDim]) >=
        Math.round(this._scrollPosition + this._viewDim1)
    ) {
      lastVisible--;
    }

    if (
      firstVisible !== this._firstVisible ||
      lastVisible !== this._lastVisible
    ) {
      this._firstVisible = firstVisible;
      this._lastVisible = lastVisible;
      if (options && options.emit) {
        this._emitRange();
      }
    }
  }
}
