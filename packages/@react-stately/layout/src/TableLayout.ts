/*
 * Copyright 2020 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import {ColumnSize, TableCollection} from '@react-types/table';
import {DropTarget, Node} from '@react-types/shared';
import {getChildNodes} from '@react-stately/collections';
import {GridNode} from '@react-types/grid';
import {InvalidationContext, LayoutInfo, Point, Rect, Size} from '@react-stately/virtualizer';
import {Key} from 'react';
import {LayoutNode, ListLayout, ListLayoutOptions} from './ListLayout';
import {TableColumnLayout} from '@react-stately/table';

type TableLayoutOptions<T> = ListLayoutOptions<T> & {
  columnLayout: TableColumnLayout<T>,
  initialCollection: TableCollection<T>
}

export class TableLayout<T> extends ListLayout<T> {
  collection: TableCollection<T>;
  lastCollection: TableCollection<T>;
  columnWidths: Map<Key, number> = new Map();
  stickyColumnIndices: number[];
  wasLoading = false;
  isLoading = false;
  lastPersistedKeys: Set<Key> = null;
  persistedIndices: Map<Key, number[]> = new Map();
  private disableSticky: boolean;
  columnLayout: TableColumnLayout<T>;
  controlledColumns: Map<Key, GridNode<unknown>>;
  uncontrolledColumns: Map<Key, GridNode<unknown>>;
  uncontrolledWidths: Map<Key, ColumnSize>;
  resizingColumn: Key | null;

  constructor(options: TableLayoutOptions<T>) {
    super(options);
    this.collection = options.initialCollection;
    this.stickyColumnIndices = [];
    this.disableSticky = this.checkChrome105();
    this.columnLayout = options.columnLayout;
    let [controlledColumns, uncontrolledColumns] = this.columnLayout.splitColumnsIntoControlledAndUncontrolled(this.collection.columns);
    this.controlledColumns = controlledColumns;
    this.uncontrolledColumns = uncontrolledColumns;
    this.uncontrolledWidths = this.columnLayout.getInitialUncontrolledWidths(uncontrolledColumns);
  }

  protected shouldInvalidateEverything(invalidationContext: InvalidationContext<Node<T>, unknown>): boolean {
    // If columns changed, clear layout cache.
    return super.shouldInvalidateEverything(invalidationContext) || (
      !this.lastCollection ||
      this.collection.columns.length !== this.lastCollection.columns.length ||
      this.collection.columns.some((c, i) =>
        c.key !== this.lastCollection.columns[i].key ||
        c.props.width !== this.lastCollection.columns[i].props.width ||
        c.props.minWidth !== this.lastCollection.columns[i].props.minWidth ||
        c.props.maxWidth !== this.lastCollection.columns[i].props.maxWidth
      )
    );
  }

  getResizerPosition(): Key {
    return this.getLayoutInfo(this.resizingColumn)?.rect.maxX;
  }

  getColumnWidth(key: Key): number {
    return this.columnLayout.getColumnWidth(key) ?? 0;
  }

  getColumnMinWidth(key: Key): number {
    let column = this.collection.columns.find(col => col.key === key);
    if (!column) {
      return 0;
    }
    return this.columnLayout.getColumnMinWidth(key);
  }

  getColumnMaxWidth(key: Key): number {
    let column = this.collection.columns.find(col => col.key === key);
    if (!column) {
      return 0;
    }
    return this.columnLayout.getColumnMaxWidth(key);
  }

  // outside, where this is called, should call props.onColumnResizeStart...
  startResize(key: Key): void {
    this.resizingColumn = key;
  }

  // only way to call props.onColumnResize with the new size outside of Layout is to send the result back
  updateResizedColumns(key: Key, width: number): Map<Key, ColumnSize> {
    let newControlled = new Map(Array.from(this.controlledColumns).map(([key, entry]) => [key, entry.props.width]));
    let newSizes = this.columnLayout.resizeColumnWidth(this.virtualizer.visibleRect.width, this.collection, newControlled, this.uncontrolledWidths, key, width);

    let map = new Map(Array.from(this.uncontrolledColumns).map(([key]) => [key, newSizes.get(key)]));
    map.set(key, width);
    this.uncontrolledWidths = map;
    // relayoutNow still uses setState, should happen at the same time the parent
    // component's state is processed as a result of props.onColumnResize
    if (this.uncontrolledWidths.size > 0) {
      this.virtualizer.relayoutNow({sizeChanged: true});
    }
    return newSizes;
  }

  endResize(): void {
    this.resizingColumn = null;
  }

  buildCollection(): LayoutNode[] {
    // Track whether we were previously loading. This is used to adjust the animations of async loading vs inserts.
    let loadingState = this.collection.body.props.loadingState;
    this.wasLoading = this.isLoading;
    this.isLoading = loadingState === 'loading' || loadingState === 'loadingMore';
    this.stickyColumnIndices = [];

    for (let column of this.collection.columns) {
      // The selection cell and any other sticky columns always need to be visible.
      // In addition, row headers need to be in the DOM for accessibility labeling.
      if (column.props.isDragButtonCell || column.props.isSelectionCell || this.collection.rowHeaderColumnKeys.has(column.key)) {
        this.stickyColumnIndices.push(column.index);
      }
    }

    let [controlledColumns, uncontrolledColumns] = this.columnLayout.splitColumnsIntoControlledAndUncontrolled(this.collection.columns);
    this.controlledColumns = controlledColumns;
    this.uncontrolledColumns = uncontrolledColumns;
    let colWidths = this.columnLayout.recombineColumns(this.collection.columns, this.uncontrolledWidths, uncontrolledColumns, controlledColumns);

    this.columnWidths = this.columnLayout.buildColumnWidths(this.virtualizer.visibleRect.width, this.collection, colWidths);

    let header = this.buildHeader();
    let body = this.buildBody(0);
    this.lastPersistedKeys = null;

    body.layoutInfo.rect.width = Math.max(header.layoutInfo.rect.width, body.layoutInfo.rect.width);
    this.contentSize = new Size(body.layoutInfo.rect.width, body.layoutInfo.rect.maxY);
    return [
      header,
      body
    ];
  }

  buildHeader(): LayoutNode {
    let rect = new Rect(0, 0, 0, 0);
    let layoutInfo = new LayoutInfo('header', 'header', rect);

    let y = 0;
    let width = 0;
    let children: LayoutNode[] = [];
    for (let headerRow of this.collection.headerRows) {
      let layoutNode = this.buildChild(headerRow, 0, y);
      layoutNode.layoutInfo.parentKey = 'header';
      y = layoutNode.layoutInfo.rect.maxY;
      width = Math.max(width, layoutNode.layoutInfo.rect.width);
      layoutNode.index = children.length;
      children.push(layoutNode);
    }

    rect.width = width;
    rect.height = y;

    this.layoutInfos.set('header', layoutInfo);

    return {
      layoutInfo,
      children,
      validRect: layoutInfo.rect
    };
  }

  buildHeaderRow(headerRow: GridNode<T>, x: number, y: number): LayoutNode {
    let rect = new Rect(0, y, 0, 0);
    let row = new LayoutInfo('headerrow', headerRow.key, rect);

    let height = 0;
    let columns: LayoutNode[] = [];
    for (let cell of getChildNodes(headerRow, this.collection)) {
      let layoutNode = this.buildChild(cell, x, y);
      layoutNode.layoutInfo.parentKey = row.key;
      x = layoutNode.layoutInfo.rect.maxX;
      height = Math.max(height, layoutNode.layoutInfo.rect.height);
      layoutNode.index = columns.length;
      columns.push(layoutNode);
    }
    for (let [i, layout] of columns.entries()) {
      layout.layoutInfo.zIndex = columns.length - i + 1;
    }

    this.setChildHeights(columns, height);

    rect.height = height;
    rect.width = x;

    return {
      layoutInfo: row,
      children: columns,
      validRect: rect
    };
  }

  setChildHeights(children: LayoutNode[], height: number) {
    for (let child of children) {
      if (child.layoutInfo.rect.height !== height) {
        // Need to copy the layout info before we mutate it.
        child.layoutInfo = child.layoutInfo.copy();
        this.layoutInfos.set(child.layoutInfo.key, child.layoutInfo);

        child.layoutInfo.rect.height = height;
      }
    }
  }

  // used to get the column widths when rendering to the DOM
  getRenderedColumnWidth(node: GridNode<T>) {
    let colspan = node.colspan ?? 1;
    let colIndex = node.colIndex ?? node.index;
    let width = 0;
    for (let i = colIndex; i < colIndex + colspan; i++) {
      let column = this.collection.columns[i];
      if (column?.key != null) {
        width += this.columnWidths.get(column.key);
      }
    }

    return width;
  }

  getEstimatedHeight(node: GridNode<T>, width: number, height: number, estimatedHeight: number) {
    let isEstimated = false;

    // If no explicit height is available, use an estimated height.
    if (height == null) {
      // If a previous version of this layout info exists, reuse its height.
      // Mark as estimated if the size of the overall collection view changed,
      // or the content of the item changed.
      let previousLayoutNode = this.layoutNodes.get(node.key);
      if (previousLayoutNode) {
        height = previousLayoutNode.layoutInfo.rect.height;
        isEstimated = node !== previousLayoutNode.node || width !== previousLayoutNode.layoutInfo.rect.width || previousLayoutNode.layoutInfo.estimatedSize;
      } else {
        height = estimatedHeight;
        isEstimated = true;
      }
    }

    return {height, isEstimated};
  }

  buildColumn(node: GridNode<T>, x: number, y: number): LayoutNode {
    let width = this.getRenderedColumnWidth(node);
    let {height, isEstimated} = this.getEstimatedHeight(node, width, this.headingHeight, this.estimatedHeadingHeight);
    let rect = new Rect(x, y, width, height);
    let layoutInfo = new LayoutInfo(node.type, node.key, rect);
    layoutInfo.isSticky = !this.disableSticky && (node.props?.isDragButtonCell || node.props?.isSelectionCell);
    layoutInfo.zIndex = layoutInfo.isSticky ? 2 : 1;
    layoutInfo.estimatedSize = isEstimated;

    return {
      layoutInfo,
      validRect: layoutInfo.rect
    };
  }

  buildBody(y: number): LayoutNode {
    let rect = new Rect(0, y, 0, 0);
    let layoutInfo = new LayoutInfo('rowgroup', 'body', rect);

    let startY = y;
    let skipped = 0;
    let width = 0;
    let children: LayoutNode[] = [];
    for (let [i, node] of [...this.collection].entries()) {
      let rowHeight = (this.rowHeight ?? this.estimatedRowHeight) + 1;

      // Skip rows before the valid rectangle unless they are already cached.
      if (y + rowHeight < this.validRect.y && !this.isValid(node, y)) {
        y += rowHeight;
        skipped++;
        continue;
      }

      let layoutNode = this.buildChild(node, 0, y);
      layoutNode.layoutInfo.parentKey = 'body';
      layoutNode.index = i;
      y = layoutNode.layoutInfo.rect.maxY;
      width = Math.max(width, layoutNode.layoutInfo.rect.width);
      children.push(layoutNode);

      if (y > this.validRect.maxY) {
        // Estimate the remaining height for rows that we don't need to layout right now.
        y += (this.collection.size - (skipped + children.length)) * rowHeight;
        break;
      }
    }

    if (this.isLoading) {
      // Add some margin around the loader to ensure that scrollbars don't flicker in and out.
      let rect = new Rect(40,  Math.max(y, 40), (width || this.virtualizer.visibleRect.width) - 80, children.length === 0 ? this.virtualizer.visibleRect.height - 80 : 60);
      let loader = new LayoutInfo('loader', 'loader', rect);
      loader.parentKey = 'body';
      loader.isSticky = !this.disableSticky && children.length === 0;
      this.layoutInfos.set('loader', loader);
      children.push({layoutInfo: loader, validRect: loader.rect});
      y = loader.rect.maxY;
      width = Math.max(width, rect.width);
    } else if (children.length === 0) {
      let rect = new Rect(40, Math.max(y, 40), this.virtualizer.visibleRect.width - 80, this.virtualizer.visibleRect.height - 80);
      let empty = new LayoutInfo('empty', 'empty', rect);
      empty.parentKey = 'body';
      empty.isSticky = !this.disableSticky;
      this.layoutInfos.set('empty', empty);
      children.push({layoutInfo: empty, validRect: empty.rect});
      y = empty.rect.maxY;
      width = Math.max(width, rect.width);
    }

    rect.width = width;
    rect.height = y - startY;

    this.layoutInfos.set('body', layoutInfo);

    return {
      layoutInfo,
      children,
      validRect: layoutInfo.rect.intersection(this.validRect)
    };
  }

  buildNode(node: GridNode<T>, x: number, y: number): LayoutNode {
    switch (node.type) {
      case 'headerrow':
        return this.buildHeaderRow(node, x, y);
      case 'item':
        return this.buildRow(node, x, y);
      case 'column':
      case 'placeholder':
        return this.buildColumn(node, x, y);
      case 'cell':
        return this.buildCell(node, x, y);
      default:
        throw new Error('Unknown node type ' + node.type);
    }
  }

  buildRow(node: GridNode<T>, x: number, y: number): LayoutNode {
    let rect = new Rect(x, y, 0, 0);
    let layoutInfo = new LayoutInfo('row', node.key, rect);

    let children: LayoutNode[] = [];
    let height = 0;
    for (let [i, child] of [...getChildNodes(node, this.collection)].entries()) {
      if (child.type === 'cell') {
        if (x > this.validRect.maxX) {
          // Adjust existing cached layoutInfo to ensure that it is out of view.
          // This can happen due to column resizing.
          let layoutNode = this.layoutNodes.get(child.key);
          if (layoutNode) {
            layoutNode.layoutInfo.rect.x = x;
            x += layoutNode.layoutInfo.rect.width;
          }
        } else {
          let layoutNode = this.buildChild(child, x, y);
          x = layoutNode.layoutInfo.rect.maxX;
          height = Math.max(height, layoutNode.layoutInfo.rect.height);
          layoutNode.index = i;
          children.push(layoutNode);
        }
      }
    }

    this.setChildHeights(children, height);

    rect.width = this.layoutInfos.get('header').rect.width;
    rect.height = height + 1; // +1 for bottom border

    return {
      layoutInfo,
      children,
      validRect: rect.intersection(this.validRect)
    };
  }

  buildCell(node: GridNode<T>, x: number, y: number): LayoutNode {
    let width = this.getRenderedColumnWidth(node);
    let {height, isEstimated} = this.getEstimatedHeight(node, width, this.rowHeight, this.estimatedRowHeight);
    let rect = new Rect(x, y, width, height);
    let layoutInfo = new LayoutInfo(node.type, node.key, rect);
    layoutInfo.isSticky = !this.disableSticky && (node.props?.isDragButtonCell || node.props?.isSelectionCell);
    layoutInfo.zIndex = layoutInfo.isSticky ? 2 : 1;
    layoutInfo.estimatedSize = isEstimated;

    return {
      layoutInfo,
      validRect: rect
    };
  }

  getVisibleLayoutInfos(rect: Rect) {
    // If layout hasn't yet been done for the requested rect, union the
    // new rect with the existing valid rect, and recompute.
    if (!this.validRect.containsRect(rect) && this.lastCollection) {
      this.lastValidRect = this.validRect;
      this.validRect = this.validRect.union(rect);
      this.rootNodes = this.buildCollection();
    }

    let res: LayoutInfo[] = [];

    this.buildPersistedIndices();
    for (let node of this.rootNodes) {
      res.push(node.layoutInfo);
      this.addVisibleLayoutInfos(res, node, rect);
    }

    return res;
  }

  addVisibleLayoutInfos(res: LayoutInfo[], node: LayoutNode, rect: Rect) {
    if (!node.children || node.children.length === 0) {
      return;
    }

    switch (node.layoutInfo.type) {
      case 'header': {
        for (let child of node.children) {
          res.push(child.layoutInfo);
          this.addVisibleLayoutInfos(res, child, rect);
        }
        break;
      }
      case 'rowgroup': {
        let firstVisibleRow = this.binarySearch(node.children, rect.topLeft, 'y');
        let lastVisibleRow = this.binarySearch(node.children, rect.bottomRight, 'y');

        // Add persisted rows before the visible rows.
        let persistedRowIndices = this.persistedIndices.get(node.layoutInfo.key);
        let persistIndex = 0;
        while (
          persistedRowIndices &&
          persistIndex < persistedRowIndices.length &&
          persistedRowIndices[persistIndex] < firstVisibleRow
        ) {
          let idx = persistedRowIndices[persistIndex];
          if (idx < node.children.length) {
            res.push(node.children[idx].layoutInfo);
            this.addVisibleLayoutInfos(res, node.children[idx], rect);
          }
          persistIndex++;
        }

        for (let i = firstVisibleRow; i <= lastVisibleRow; i++) {
          // Skip persisted rows that overlap with visible cells.
          while (persistedRowIndices && persistIndex < persistedRowIndices.length && persistedRowIndices[persistIndex] < i) {
            persistIndex++;
          }

          res.push(node.children[i].layoutInfo);
          this.addVisibleLayoutInfos(res, node.children[i], rect);
        }

        // Add persisted rows after the visible rows.
        while (persistedRowIndices && persistIndex < persistedRowIndices.length) {
          let idx = persistedRowIndices[persistIndex++];
          if (idx < node.children.length) {
            res.push(node.children[idx].layoutInfo);
          }
        }
        break;
      }
      case 'headerrow':
      case 'row': {
        let firstVisibleCell = this.binarySearch(node.children, rect.topLeft, 'x');
        let lastVisibleCell = this.binarySearch(node.children, rect.topRight, 'x');
        let stickyIndex = 0;

        // Add persisted/sticky cells before the visible cells.
        let persistedCellIndices = this.persistedIndices.get(node.layoutInfo.key) || this.stickyColumnIndices;
        while (stickyIndex < persistedCellIndices.length && persistedCellIndices[stickyIndex] < firstVisibleCell) {
          let idx = persistedCellIndices[stickyIndex];
          if (idx < node.children.length) {
            res.push(node.children[idx].layoutInfo);
          }
          stickyIndex++;
        }

        for (let i = firstVisibleCell; i <= lastVisibleCell; i++) {
          // Skip sticky cells that overlap with visible cells.
          while (stickyIndex < persistedCellIndices.length && persistedCellIndices[stickyIndex] < i) {
            stickyIndex++;
          }

          res.push(node.children[i].layoutInfo);
        }

        // Add any remaining sticky cells after the visible cells.
        while (stickyIndex < persistedCellIndices.length) {
          let idx = persistedCellIndices[stickyIndex++];
          if (idx < node.children.length) {
            res.push(node.children[idx].layoutInfo);
          }
        }
        break;
      }
      default:
        throw new Error('Unknown node type ' + node.layoutInfo.type);
    }
  }

  binarySearch(items: LayoutNode[], point: Point, axis: 'x' | 'y') {
    let low = 0;
    let high = items.length - 1;
    while (low <= high) {
      let mid = (low + high) >> 1;
      let item = items[mid];

      if ((axis === 'x' && item.layoutInfo.rect.maxX < point.x) || (axis === 'y' && item.layoutInfo.rect.maxY < point.y)) {
        low = mid + 1;
      } else if ((axis === 'x' && item.layoutInfo.rect.x > point.x) || (axis === 'y' && item.layoutInfo.rect.y > point.y)) {
        high = mid - 1;
      } else {
        return mid;
      }
    }

    return Math.max(0, Math.min(items.length - 1, low));
  }

  buildPersistedIndices() {
    if (this.virtualizer.persistedKeys === this.lastPersistedKeys) {
      return;
    }

    this.lastPersistedKeys = this.virtualizer.persistedKeys;
    this.persistedIndices.clear();

    // Build a map of parentKey => indices of children to persist.
    for (let key of this.virtualizer.persistedKeys) {
      let layoutInfo = this.layoutInfos.get(key);

      // Walk up ancestors so parents are also persisted if children are.
      while (layoutInfo && layoutInfo.parentKey) {
        let collectionNode = this.collection.getItem(layoutInfo.key);
        let indices = this.persistedIndices.get(layoutInfo.parentKey);
        if (!indices) {
          // stickyColumnIndices are always persisted along with any cells from persistedKeys.
          indices = collectionNode.type === 'cell' || collectionNode.type === 'column' ? [...this.stickyColumnIndices] : [];
          this.persistedIndices.set(layoutInfo.parentKey, indices);
        }

        let index = this.layoutNodes.get(layoutInfo.key).index;

        if (!indices.includes(index)) {
          indices.push(index);
        }

        layoutInfo = this.layoutInfos.get(layoutInfo.parentKey);
      }
    }

    for (let indices of this.persistedIndices.values()) {
      indices.sort((a, b) => a - b);
    }
  }

  getInitialLayoutInfo(layoutInfo: LayoutInfo) {
    let res = super.getInitialLayoutInfo(layoutInfo);
    res.transform = null;
    return res;
  }

  getFinalLayoutInfo(layoutInfo: LayoutInfo) {
    let res = super.getFinalLayoutInfo(layoutInfo);
    res.transform = null;
    return res;
  }

  // Checks if Chrome version is 105 or greater
  private checkChrome105() {
    if (typeof window === 'undefined' || window.navigator == null) {
      return false;
    }

    let isChrome105;
    if (window.navigator['userAgentData']) {
      isChrome105 = window.navigator['userAgentData']?.brands.some(b => b.brand === 'Chromium' && Number(b.version) === 105);
    } else {
      let regex = /Chrome\/(\d+)/;
      let matches = regex.exec(window.navigator.userAgent);
      isChrome105 = matches && matches.length >= 2 && Number(matches[1]) === 105;
    }

    return isChrome105;
  }
  getDropTargetFromPoint(x: number, y: number, isValidDropTarget: (target: DropTarget) => boolean): DropTarget {
    x += this.virtualizer.visibleRect.x;
    y += this.virtualizer.visibleRect.y;

    // Offset for height of header row
    y -= this.virtualizer.layout.getVisibleLayoutInfos(new Rect(x, y, 1, 1)).find(info => info.type === 'headerrow')?.rect.height;

    // Custom variation of this.virtualizer.keyAtPoint that ignores body
    let key: Key;
    let point = new Point(x, y);
    let rectAtPoint = new Rect(point.x, point.y, 1, 1);
    let layoutInfos = this.virtualizer.layout.getVisibleLayoutInfos(rectAtPoint).filter(info => info.type === 'row');

    // Layout may return multiple layout infos in the case of
    // persisted keys, so find the first one that actually intersects.
    for (let layoutInfo of layoutInfos) {
      if (layoutInfo.rect.intersects(rectAtPoint)) {
        key = layoutInfo.key;
      }
    }

    if (key == null || this.collection.size === 0) {
      return {type: 'root'};
    }

    let layoutInfo = this.getLayoutInfo(key);
    let rect = layoutInfo.rect;
    let target: DropTarget = {
      type: 'item',
      key: layoutInfo.key,
      dropPosition: 'on'
    };

    // If dropping on the item isn't accepted, try the target before or after depending on the y position.
    // Otherwise, if dropping on the item is accepted, still try the before/after positions if within 10px
    // of the top or bottom of the item.
    if (!isValidDropTarget(target)) {
      if (y <= rect.y + rect.height / 2 && isValidDropTarget({...target, dropPosition: 'before'})) {
        target.dropPosition = 'before';
      } else if (isValidDropTarget({...target, dropPosition: 'after'})) {
        target.dropPosition = 'after';
      }
    } else if (y <= rect.y + 10 && isValidDropTarget({...target, dropPosition: 'before'})) {
      target.dropPosition = 'before';
    } else if (y >= rect.maxY - 10 && isValidDropTarget({...target, dropPosition: 'after'})) {
      target.dropPosition = 'after';
    }

    return target;
  }
}
