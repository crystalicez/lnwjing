import { ActionButton, FormInput, FormField } from '../ui/UiPrimitives.js';
import { useEffect, useState, type ReactElement } from 'react';
import type { UiLocale, WorkflowChoicesResult, WorkflowTemplate } from '@lnwjing/ipc-contracts';
import { SearchableSelect } from '../../components/ui/SearchableSelect.js';
import { v580Strings, workflowLocalized } from '../../i18n/v580-copy.js';

type OfficeInfo = NonNullable<WorkflowChoicesResult['file']>;
type Choice = {value:string;label:string};

export function WorkflowInputForm(props: {
  readonly template: WorkflowTemplate;
  readonly workspaceId: string | null;
  readonly locale: UiLocale;
  readonly values: Readonly<Record<string, string>>;
  readonly onChange: (values: Record<string, string>) => void;
  readonly disabled: boolean;
  readonly invalidKeys?: ReadonlySet<string>;
}): ReactElement {
  const copy = v580Strings(props.locale).workflows;
  const [browsing,setBrowsing] = useState<string|null>(null);
  const [generating,setGenerating] = useState(false);
  const [error,setError] = useState<string|null>(null);
  const [inputInfo,setInputInfo] = useState<OfficeInfo|null>(null);
  const [templateInfo,setTemplateInfo] = useState<OfficeInfo|null>(null);
  const [version,setVersion] = useState<string|null>(null);
  const [branches,setBranches] = useState<readonly string[]>([]);
  const [reportSheet,setReportSheet] = useState('');
  const [advanced,setAdvanced] = useState(false);
  const [manualFields,setManualFields] = useState<ReadonlySet<string>>(new Set());
  const inputPath = props.values.inputPath ?? '';
  const templatePath = props.values.templatePath ?? '';

  useEffect(() => {
    let live = true;
    setVersion(null); setBranches([]);
    if (props.workspaceId) {
      void window.lnwjing.inspectWorkflowChoices({workspaceId:props.workspaceId}).then(result => {
        if (live) {setVersion(result.projectVersion);setBranches(result.branches);}
      }).catch(() => { if(live) setVersion(null); });

    }
    return ():void => {live=false;};
  },[props.workspaceId]);

  useEffect(() => {
    let live=true;
    setInputInfo(null);
    if (props.workspaceId && inputPath && /\.(csv|xlsx)$/i.test(inputPath)) {
      const workspaceId=props.workspaceId;
      const token=setTimeout(() => {
        void window.lnwjing.inspectWorkflowChoices({workspaceId,filePath:inputPath}).then(result => {
          if(live) { setInputInfo(result.file); setError(null); }
        }).catch(cause => { if(live) setError(String(cause)); });
      },250);
      return ():void => {live=false;clearTimeout(token);};
    }
    return ():void => {live=false;};
  },[props.workspaceId,inputPath]);

  useEffect(() => {
    let live=true;
    setTemplateInfo(null);setReportSheet('');
    if (props.workspaceId && templatePath && /\.xlsx$/i.test(templatePath)) {
      const workspaceId=props.workspaceId;
      const token=setTimeout(() => {
        void window.lnwjing.inspectWorkflowChoices({workspaceId,filePath:templatePath}).then(result => {
          if(live) {setTemplateInfo(result.file);setReportSheet(result.file?.sheets[0]?.name ?? '');setError(null);}
        }).catch(cause => {if(live) setError(String(cause));});
      },250);
      return ():void => {live=false;clearTimeout(token);};
    }
    return ():void => {live=false;};
  },[props.workspaceId,templatePath]);

  useEffect(() => {
    if (!inputInfo || props.template.id !== 'data-audit') return;
    const firstSheet = inputInfo.sheets[0];
    if (!firstSheet) return;
    const selectedSheet = inputInfo.sheets.find(sheet => sheet.name === props.values.sheet) ?? firstSheet;
    const columns = selectedSheet.columns;
    const key = columns.find(name => /^(?:id|.*[_ -]id|code|.*[_ -]code|รหัส|เลขที่)/i.test(name)) ?? columns[0];
    const next = {...props.values};
    if (!next.sheet || !inputInfo.sheets.some(s => s.name === next.sheet)) next.sheet=firstSheet.name;
    if (!next.keyColumns && key) next.keyColumns=key;
    if (next.sheet !== props.values.sheet || next.keyColumns !== props.values.keyColumns) props.onChange(next);
  },[inputInfo,props.template.id,props.values.sheet,props.values.keyColumns]);

  useEffect(() => {
    if (props.template.id !== 'template-report' || !inputPath || props.values.outputPath) return;
    const output = inputPath.replace(/\.[^./\\]+$/, '') + '-report.xlsx';
    if (output !== inputPath) props.onChange({...props.values,outputPath:output});
  },[props.template.id,inputPath,props.values.outputPath]);

  function change(key:string,value:string):void {
    const next:Record<string,string>={...props.values,[key]:value};
    if(key==='inputPath') {next.sheet='';next.keyColumns='';if(props.template.id==='template-report')next.outputPath='';}
    if(key==='templatePath') next.mappingPath='';
    if(key==='sheet' && inputInfo) {
      const cols=inputInfo.sheets.find(sheet=>sheet.name===value)?.columns ?? [];
      next.keyColumns=cols.find(name=>/^(?:id|.*[_ -]id|code|.*[_ -]code|รหัส|เลขที่)/i.test(name)) ?? cols[0] ?? '';
    }
    props.onChange(next);
  }

  async function browse(key:string):Promise<void> {
    if(browsing) return;
    setBrowsing(key);setError(null);
    try {
      const selected=await window.lnwjing.chooseWorkflowDataFile();
      if(selected.filePath) change(key,selected.filePath);
    } catch(cause) {setError(String(cause));}
    finally {setBrowsing(null);}
  }
  async function generateMapping():Promise<void> {
    if(!props.workspaceId || !templatePath || !reportSheet || generating)return;
    setGenerating(true);setError(null);
    try {
      const result=await window.lnwjing.generateWorkflowMapping({workspaceId:props.workspaceId,templatePath,sheet:reportSheet});
      change('mappingPath',result.filePath);
    } catch(cause) {setError(String(cause));}
    finally {setGenerating(false);}
  }
  function choices(key:string):readonly Choice[] {
    if(key==='sheet')return inputInfo?.sheets.map(sheet=>({value:sheet.name,label:sheet.name})) ?? [];
    if(key==='keyColumns') {
      const sheet=inputInfo?.sheets.find(item=>item.name===(props.values.sheet || inputInfo.sheets[0]?.name));
      return [...new Set(sheet?.columns ?? [])].map(value=>({value,label:value}));
    }
    if(key==='baseRef')return [...new Set(['HEAD',...branches])].map(value=>({value,label:value}));
    if(key==='targetVersion')return version?[{value:version,label:version}]:[];
    if(key==='connection')return [
      {value:'MCP Gateway',label:copy.connectionMcp},
      {value:'Secure Tunnel',label:copy.connectionTunnel},
      {value:'Remote MCP',label:copy.connectionRemote},
      {value:'Local STDIO',label:copy.connectionLocal},
    ];
    return [];
  }
  const autoFields = new Set(['sheet','keyColumns','baseRef','targetVersion','connection']);
  return (
    <div className="workflow-input-fields">
      <div className="workflow-input-mode">
        <span className="hint">{copy.autoIntro}</span>
        <ActionButton type="button" disabled={props.disabled} onClick={()=>setAdvanced(!advanced)}>
          {advanced?copy.basicMode:copy.advancedMode}
        </ActionButton>
      </div>
      {props.template.inputFields.map(field=>{
        if(field.key==='range' && !advanced && !props.values.range)return null;
        const label=workflowLocalized(props.locale,{th:field.labelTh,en:field.labelEn});
        const isFile=['inputPath','templatePath','mappingPath'].includes(field.key);
        const invalid=props.invalidKeys?.has(field.key)??false;
        const errorId=`workflow-${field.key}-error`;
        const available=choices(field.key);
        const manual=advanced || manualFields.has(field.key);
        const hasAuto=autoFields.has(field.key);
        return <FormField id={`workflow-${field.key}`} label={label} required={field.required}
          className="workflow-field" key={field.key}>
          <div className="workflow-field-control">
            {field.type==='enum' || (hasAuto && !manual) ? <SearchableSelect
              id={`workflow-${field.key}`} value={props.values[field.key] ?? ''}
              disabled={props.disabled || (hasAuto && available.length===0)}
              label={label} invalid={invalid} describedBy={invalid?errorId:undefined}
              placeholder={available.length===0?copy.waitForChoices:copy.select}
              options={[{value:'',label:copy.select},...(field.type==='enum'
                ? (field.options ?? []).map(value=>({value,label:value})) : available)]}
              onChange={value=>change(field.key,value)}/> :
              <FormInput id={`workflow-${field.key}`} type="text"
                disabled={props.disabled} autoComplete="off"
                aria-invalid={invalid||undefined} aria-describedby={invalid?errorId:undefined}
                value={props.values[field.key] ?? ''} onChange={event=>change(field.key,event.target.value)}
                placeholder={isFile?copy.path:field.key==='baseRef'?copy.baseRefPlaceholder:field.key}/>
            }
            {isFile ? <ActionButton type="button" className="ui-browse-button" disabled={props.disabled||!!browsing}
              onClick={()=>{void browse(field.key);}}>{browsing===field.key?'…':copy.browse}</ActionButton>:null}
            {hasAuto && !advanced ? <ActionButton type="button" disabled={props.disabled}
              onClick={()=>setManualFields(old=>{
                const next=new Set(old);if(next.has(field.key))next.delete(field.key);else next.add(field.key);return next;
              })}>{manual?copy.chooseMode:copy.enterManually}</ActionButton>:null}
          </div>
          {field.key==='baseRef'?<p className="hint">{copy.baseRefHelp}</p>:null}
          {field.key==='keyColumns' && inputInfo?<p className="hint">{copy.keyColumnHelp}</p>:null}
          {field.key==='mappingPath'?<>
            {templateInfo && templateInfo.sheets.length>0?<div className="workflow-mapping-tools">
              <SearchableSelect label={copy.reportSheet} value={reportSheet} disabled={props.disabled}
                options={templateInfo.sheets.map(sheet=>({value:sheet.name,label:sheet.name}))}
                onChange={setReportSheet}/>
              <ActionButton type="button" disabled={props.disabled||generating||!reportSheet}
                onClick={()=>{void generateMapping();}}>{generating?'…':copy.generateMapping}</ActionButton>
            </div>:<p className="hint">{copy.chooseTemplateFirst}</p>}
            <p className="hint">{copy.mappingHelp}</p>
          </>:null}
          {field.key==='outputPath'?<p className="hint">{copy.outputHelp}</p>:null}
          {field.key==='sheet'&&inputInfo?<p className="hint">{copy.detectedSheets} {inputInfo.sheets.length}</p>:null}
          {invalid?<p id={errorId} className="field-validation-message" role="alert">{copy.required}</p>:null}
        </FormField>;
      })}
      {error?<p role="alert" className="workflow-field-error">{error}</p>:null}
    </div>
  );
}
