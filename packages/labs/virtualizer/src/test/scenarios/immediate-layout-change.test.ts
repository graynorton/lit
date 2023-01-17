/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import {ignoreBenignErrors} from '../helpers.js';
import {html, LitElement} from 'lit';
import {customElement, state} from 'lit/decorators.js';
import '../../lit-virtualizer.js';
import {grid} from '../../layouts/grid.js';
import {expect, html as testingHtml, fixture} from '@open-wc/testing';
import {LayoutSpecifier} from '../../layouts/shared/Layout.js';

@customElement('my-example')
export class MyExample extends LitElement {
  data: string[] = new Array(1000).fill('').map((_, idx) => `Item ${idx}`);

  @state()
  layout: LayoutSpecifier | undefined = undefined;

  render() {
    return html`
      <lit-virtualizer
        .layout=${this.layout!}
        .items=${this.data}
        .renderItem=${(item: string) => html`<div>${item}</div>`}
      ></lit-virtualizer>
    `;
  }

  firstUpdated() {
    this.layout = grid();
  }
}

// This is one minimal repro case for https://github.com/lit/lit/issues/3243.
// The issue was originally reported in a more complicated case involving the
// use of lit-mobx. Other minimal repro cases are probably possible.
// The fix we've identified for this issue is a low-level change to the logic
// for completing the virtualizer update cycle after children have been
// rendered or re-rendered.
describe('TODO', () => {
  ignoreBenignErrors(beforeEach, afterEach);

  it('should TODO', async () => {
    const example = (await fixture(
      testingHtml`<my-example></my-example>`
    )) as MyExample;
    expect(example).to.be.instanceof(MyExample);
  });
});
