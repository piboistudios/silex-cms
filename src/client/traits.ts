import { ClientConfig } from '@silexlabs/silex/src/ts/client/config'
import { html, render } from 'lit-html'

/**
 * @fileoverview
 * This adds these traits to all components:
 *   - unwrap the component
 */

export const UNWRAP_ID = 'plugin-unwrap'
export const REACTIVE_ID = 'plugin-reactive'
const LABEL = 'Unwrap content'
const LABEL_DETAILS = 'Remove the component and keep its content'

export default function(config: ClientConfig/*, opts: EleventyPluginOptions */): void {
  config.on('silex:grapesjs:end', () => {
    const editor = config.getEditor()

    // Add the new trait to all component types
    editor.DomComponents.getTypes().map(type => {
      editor.DomComponents.addType(type.id, {
        model: {
          defaults: {
            traits: [
              // Keep the type original traits
              ...(editor.DomComponents.getType(type.id)?.model.prototype.defaults.traits || []),
              // Add the new trait
              {
                label: LABEL,
                type: UNWRAP_ID,
                name: UNWRAP_ID,
              },
              {
                label: "Reactive?",
                type: REACTIVE_ID,
                name: REACTIVE_ID
              }
            ]
          }
        }
      })
    })

    function doRender(el: HTMLElement, remove: boolean, id:string, labelDetails:string) {
      render(html`
      <label for=${id} class="gjs-one-bg silex-label">${labelDetails}</label>
      <input
        type="checkbox"
        id=${id}
        @change=${event => doRender(el, event.target.checked, id, labelDetails)}
        ?checked=${remove}
        style="appearance: auto; width: 20px; height: 20px;"
      >
    `, el)
    }
    function doRenderCurrent(el: HTMLElement, id:string, labelDetails:string) {
      doRender(el, editor.getSelected()?.get(id), id, labelDetails)
    }

    // inspired by https://github.com/olivmonnier/grapesjs-plugin-header/blob/master/src/components.js
    [[UNWRAP_ID, LABEL_DETAILS], [REACTIVE_ID, "Make dat bit reactive cuh"]]
      .forEach(([id,labelDet]) => {
        editor.TraitManager.addType(id, {
          createInput() {
            // Create a new element container and add some content
            const el = document.createElement('div')
            // update the UI when a page is added/renamed/removed
            editor.on('page', () => doRenderCurrent(el, id, labelDet))
            doRenderCurrent(el, id, labelDet)
            // this will be the element passed to onEvent and onUpdate
            return el
          },
          // Update the component based on UI changes
          // `elInput` is the result HTMLElement you get from `createInput`
          onEvent({ elInput, component }) {
            const value = (elInput.querySelector(`#${id}`) as HTMLInputElement)?.checked
            component.set(id, value)
          },
          // Update UI on the component change
          onUpdate({ elInput, component }) {
            const value = component.get(id)
            doRender(elInput, value, id, labelDet)
          },
        })
      })
      })
}