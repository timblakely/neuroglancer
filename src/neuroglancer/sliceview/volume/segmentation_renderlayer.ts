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

import {HashMapUint64} from 'neuroglancer/gpu_hash/hash_table';
import {GPUHashTable, HashMapShaderManager, HashSetShaderManager} from 'neuroglancer/gpu_hash/shader';
import {SegmentColorShaderManager} from 'neuroglancer/segment_color';
import {registerRedrawWhenSegmentationDisplayStateChanged, SegmentationDisplayState} from 'neuroglancer/segmentation_display_state/frontend';
import {SliceView} from 'neuroglancer/sliceview/frontend';
import {VolumeSourceOptions} from 'neuroglancer/sliceview/volume/base';
import {MultiscaleVolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {RenderLayer} from 'neuroglancer/sliceview/volume/renderlayer';
import {TrackableAlphaValue} from 'neuroglancer/trackable_alpha';
import {TrackableBoolean} from 'neuroglancer/trackable_boolean';
import {DisjointUint64Sets} from 'neuroglancer/util/disjoint_sets';
import {vec3} from 'neuroglancer/util/geom';
import {ShaderBuilder, ShaderProgram} from 'neuroglancer/webgl/shader';
import {glsl_unnormalizeUint8} from 'neuroglancer/webgl/shader_lib';

const selectedSegmentForShader = new Float32Array(8);

export class EquivalencesHashMap {
  generation = Number.NaN;
  hashMap = new HashMapUint64();
  constructor(public disjointSets: DisjointUint64Sets) {}
  update() {
    let {disjointSets} = this;
    const {generation} = disjointSets;
    if (this.generation !== generation) {
      this.generation = generation;
      let {hashMap} = this;
      hashMap.clear();
      for (let [objectId, minObjectId] of disjointSets.mappings()) {
        hashMap.set(objectId, minObjectId);
      }
    }
  }
}

export interface SliceViewSegmentationDisplayState extends SegmentationDisplayState {
  selectedAlpha: TrackableAlphaValue;
  notSelectedAlpha: TrackableAlphaValue;
  volumeSourceOptions: VolumeSourceOptions;
  hideSegmentZero: TrackableBoolean;
}

export class SegmentationRenderLayer extends RenderLayer {
  protected segmentColorShaderManager = new SegmentColorShaderManager('segmentColorHash');
  private hashTableManager = new HashSetShaderManager('visibleSegments');
  private gpuHashTable = GPUHashTable.get(this.gl, this.displayState.visibleSegments.hashTable);
  private hashTableManagerHighlighted = new HashSetShaderManager('highlightedSegments');
  private gpuHashTableHighlighted = GPUHashTable.get(this.gl, this.displayState.highlightedSegments.hashTable);

  private equivalencesShaderManager = new HashMapShaderManager('equivalences');
  private equivalencesHashMap =
      new EquivalencesHashMap(this.displayState.segmentEquivalences.disjointSets);
  private gpuEquivalencesHashTable = GPUHashTable.get(this.gl, this.equivalencesHashMap.hashMap);
  private hasEquivalences: boolean;

  constructor(
      multiscaleSource: MultiscaleVolumeChunkSource,
      public displayState: SliceViewSegmentationDisplayState) {
    super(multiscaleSource, {sourceOptions: displayState.volumeSourceOptions});
    registerRedrawWhenSegmentationDisplayStateChanged(displayState, this);
    this.registerDisposer(displayState.selectedAlpha.changed.add(() => {
      this.redrawNeeded.dispatch();
    }));
    this.registerDisposer(displayState.hideSegmentZero.changed.add(() => {
      this.redrawNeeded.dispatch();
      this.shaderUpdated = true;
    }));
    this.hasEquivalences = this.displayState.segmentEquivalences.size !== 0;
    displayState.segmentEquivalences.changed.add(() => {
      let {segmentEquivalences} = this.displayState;
      let hasEquivalences = segmentEquivalences.size !== 0;
      if (hasEquivalences !== this.hasEquivalences) {
        this.hasEquivalences = hasEquivalences;
        this.shaderUpdated = true;
        // No need to trigger redraw, since that will happen anyway.
      }
    });
    this.registerDisposer(displayState.notSelectedAlpha.changed.add(() => {
      this.redrawNeeded.dispatch();
    }));
  }

  getValueAt(position: vec3) {
    for (let alternatives of this.sources!) {
      for (let source of alternatives) {
        let result = source.getValueAt(position);
        if (result != null) {
          return result;
        }
      }
    }
    return null;
  }

  getShaderKey() {
    // The shader to use depends on whether there are any equivalences, and on whether we are hiding
    // segment ID 0.
    return `sliceview.SegmentationRenderLayer/${this.hasEquivalences}/` +
        this.displayState.hideSegmentZero.value;
  }

  defineShader(builder: ShaderBuilder) {
    super.defineShader(builder);
    this.hashTableManager.defineShader(builder);
    this.hashTableManagerHighlighted.defineShader(builder);
    builder.addFragmentCode(`
uint64_t getUint64DataValue() {
  return toUint64(getDataValue());
}
`);
    if (this.hasEquivalences) {
      this.equivalencesShaderManager.defineShader(builder);
      builder.addFragmentCode(`
uint64_t getMappedObjectId() {
  uint64_t value = getUint64DataValue();
  uint64_t mappedValue;
  if (${this.equivalencesShaderManager.getFunctionName}(value, mappedValue)) {
    return mappedValue;
  }
  return value;
}
`);
    } else {
      builder.addFragmentCode(`
uint64_t getMappedObjectId() {
  return getUint64DataValue();
}
`);
    }
    this.segmentColorShaderManager.defineShader(builder);
    builder.addUniform('highp vec4', 'uSelectedSegment', 2);
    builder.addUniform('highp float', 'uShowAllSegments');
    builder.addUniform('highp float', 'uSelectedAlpha');
    builder.addUniform('highp float', 'uNotSelectedAlpha');
    builder.addUniform('highp float', 'uSaturation');
    builder.addFragmentCode(glsl_unnormalizeUint8);
    let fragmentMain = `
  uint64_t value = getMappedObjectId();

  float alpha = uSelectedAlpha;
  float saturation = uSaturation;
`;
    if (this.displayState.hideSegmentZero.value) {
      fragmentMain += `
  if (value.low == vec4(0,0,0,0) && value.high == vec4(0,0,0,0)) {
    emit(vec4(vec4(0, 0, 0, 0)));
    return;
  }
`;
    }
    fragmentMain += `
  bool has = uShowAllSegments > 0.0 ? true : ${this.hashTableManager.hasFunctionName}(value);
  if (uSelectedSegment[0] == unnormalizeUint8(value.low) &&
      uSelectedSegment[1] == unnormalizeUint8(value.high)) {
    saturation = has ? 0.5 : 0.75;
  } else if (!has) {
    alpha = uNotSelectedAlpha;
  }
  vec3 rgb = segmentColorHash(value);
  `;

  // Override color for all highlighted segments.
  fragmentMain += `
  if(${this.hashTableManagerHighlighted.hasFunctionName}(value)) {
    rgb = vec3(0.2,0.2,2.0);
    saturation = 1.0;
  };
`;

  fragmentMain += `
  emit(vec4(mix(vec3(1.0,1.0,1.0), rgb, saturation), alpha));
`;
    builder.setFragmentMain(fragmentMain);
  }

  beginSlice(sliceView: SliceView) {
    let shader = super.beginSlice(sliceView);
    let gl = this.gl;

    let {displayState} = this;
    let {segmentSelectionState, visibleSegments} = this.displayState;
    if (!segmentSelectionState.hasSelectedSegment) {
      selectedSegmentForShader.fill(0);
    } else {
      let seg = segmentSelectionState.selectedSegment;
      let low = seg.low, high = seg.high;
      for (let i = 0; i < 4; ++i) {
        selectedSegmentForShader[i] = ((low >> (8 * i)) & 0xFF);
        selectedSegmentForShader[4 + i] = ((high >> (8 * i)) & 0xFF);
      }
    }
    gl.uniform1f(shader.uniform('uSelectedAlpha'), this.displayState.selectedAlpha.value);
    gl.uniform1f(shader.uniform('uSaturation'), this.displayState.saturation.value);
    gl.uniform1f(shader.uniform('uNotSelectedAlpha'), this.displayState.notSelectedAlpha.value);
    gl.uniform4fv(shader.uniform('uSelectedSegment'), selectedSegmentForShader);
    gl.uniform1f(shader.uniform('uShowAllSegments'), visibleSegments.hashTable.size ? 0.0 : 1.0);
    this.hashTableManager.enable(gl, shader, this.gpuHashTable);
    this.hashTableManagerHighlighted.enable(gl, shader, this.gpuHashTableHighlighted);
    if (this.hasEquivalences) {
      this.equivalencesHashMap.update();
      this.equivalencesShaderManager.enable(gl, shader, this.gpuEquivalencesHashTable);
    }

    this.segmentColorShaderManager.enable(gl, shader, displayState.segmentColorHash);
    return shader;
  }
  endSlice(shader: ShaderProgram) {
    let {gl} = this;
    this.hashTableManager.disable(gl, shader);
    this.hashTableManagerHighlighted.disable(gl, shader);
    super.endSlice(shader);
  }
}
