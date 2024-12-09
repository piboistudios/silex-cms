import { ClientConfig } from '@silexlabs/silex/src/ts/client/config'
import { EleventyPluginOptions, Silex11tyPluginWebsiteSettings } from '../client'
import { html } from 'lit-html'
import { DataSourceEditor, createDataSource } from '@silexlabs/grapesjs-data-source'

export default function(config: ClientConfig, opts: EleventyPluginOptions): void {
  config.on('silex:startup:end', () => {
    const editor = config.getEditor() as unknown as DataSourceEditor
    config.addSettings({
      id: 'cms',
      label: 'CMS',
      render: () => {
        const settings = (editor.getModel().get('settings') || {}) as Silex11tyPluginWebsiteSettings
        return html`
        <style>
          #settings-cms label {
            display: block;
            margin-bottom: 10px;
          }
          .add-ds-btn {
            width: 30px;
            height: 30px;
            margin-left: auto;
            font-size: 24px;
            background-color: var(--gjs-main-light-color);
          }
        </style>
        <div id="settings-cms" class="silex-hideable silex-hidden">
          <div class="gjs-sm-sector-title">Silex CMS</div>
          <label>
            Environment:
            <textarea 
              name="env" 
              placeholder="BASE_URL=https://example.org" 
              rows="10" 
              value=${(settings as any).env}
            >${(settings as any).env}</textarea>
          </label>
          <div class="silex-help">
            <p>The <a target="_blank" href="https://github.com/silexlabs/silex-cms">Silex CMS feature</a> integrates with your favorite headless CMS, API or database.</p>
            <p>By adding data sources to your website you activate <a target="_blank" href="https://www.11ty.dev/docs/">11ty static site generator</a> integration. When you wil publish your website, the generated files assume you build the site with 11ty and possibly with Gitlab pages.</p>
          </div>
          <div class="gjs-sm-sector-title">
            Data Sources
            <button
              class="silex-button add-ds-btn"
              title="Add a new data source"
              @click=${() => {
    editor.DataSourceManager.add(createDataSource())
  }}>
                +
              </button>
          </div>
          ${opts.view?.settingsEl ? (opts.view.settingsEl as () => HTMLElement)() : ''}
          <div class="gjs-sm-sector-title">11ty Config</div>
            <div class="silex-help">
              <p>These settings are used to configure the <a target="_blank" href="https://www.11ty.dev/docs/">11ty static site generator</a> integration.</p>
              <p>Depending on your 11ty configuration, you may need to adjust these settings, it will enable or disable features in Silex.</p>
            </div>
            <div class="silex-help">
              <p>⚠️ You need to reload Silex for these settings to take effect.</p>
            </div>
            <label for="silex-form__element">
              <span>I18N Plugin</span>
              <input type="checkbox" name="eleventyI18n" ?checked=${settings.eleventyI18n || opts.i18nPlugin} ?disabled=${!!opts.i18nPlugin}>
            </label>
            <label for="silex-form__element">
              <span>Fetch Plugin</span>
              <input type="checkbox" name="eleventyFetch" ?checked=${settings.eleventyFetch || opts.fetchPlugin} ?disabled=${!!opts.fetchPlugin}>
            </label>
            <label for="silex-form__element">
              <span>Image Plugin</span>
              <input type="checkbox" name="eleventyImage" ?checked=${settings.eleventyImage || opts.imagePlugin} ?disabled=${!!opts.imagePlugin}>
            </label>
          <div class="silex-form__group col2">
          </div>
        </div>
      </div>
      `
      }
    }, 'site')
  })
}