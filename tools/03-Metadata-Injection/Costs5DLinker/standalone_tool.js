/**
 * Standalone OpenBIM Tool: Conjuntos 5D para Presupuesto y Costes (Cost Sets (5D))
 * Repository: https://github.com/JulianBimDeveloper/ifc-hub-web-app/tree/main/tools/03-Metadata-Injection/Costs5DLinker
 * Author: Julian Mejia (@JulianBimDeveloper)
 * License: MIT
 */

/**
 * Fractal IFC Engine v2.5 (100% Client-Side Zero-Server STEP Parser, 3D Geometry Extractor & Atomic Writer)
 * Ported from JulianBimDeveloper/ifc-hub-web-app (https://github.com/JulianBimDeveloper/ifc-hub-web-app - MIT License)
 * Supports IFC2X3, IFC4, IFC4X3_ADD2 (Autodesk Revit & Autodesk Civil 3D IfcInfra Plugin)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.FractalIfcEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Complete physical IFC product types matching backend/routers/ifc.py (_IFC_PRODUCT_TYPES)
  const PHYSICAL_IFC_TYPES = new Set([
    'IFCWALL', 'IFCWALLSTANDARDCASE', 'IFCWALLELEMENTEDCASE',
    'IFCSLAB', 'IFCSLABSTANDARDCASE', 'IFCSLABELEMENTEDCASE',
    'IFCBEAM', 'IFCBEAMSTANDARDCASE',
    'IFCCOLUMN', 'IFCCOLUMNSTANDARDCASE',
    'IFCFOOTING', 'IFCPILE', 'IFCMEMBER', 'IFCMEMBERSTANDARDCASE',
    'IFCPLATE', 'IFCPLATESTANDARDCASE',
    'IFCRAILING', 'IFCSTAIR', 'IFCSTAIRFLIGHT', 'IFCRAMP', 'IFCRAMPFLIGHT',
    'IFCROOF', 'IFCCOVERING', 'IFCCURTAINWALL',
    'IFCDOOR', 'IFCDOORSTANDARDCASE', 'IFCWINDOW', 'IFCWINDOWSTANDARDCASE',
    'IFCBUILDINGELEMENTPROXY', 'IFCBUILDINGELEMENTPART',
    'IFCBUILTELEMENT', 'IFCCIVILELEMENT', 'IFCGEOGRAPHICELEMENT',
    'IFCFURNISHINGELEMENT', 'IFCFURNITURE', 'IFCSYSTEMFURNITUREELEMENT',
    'IFCELEMENTASSEMBLY', 'IFCDISCRETEACCESSORY', 'IFCFASTENER', 'IFCMECHANICALFASTENER',
    'IFCVIRTUALELEMENT', 'IFCPROXY',
    // Piping, Drainage & MEP (Critical for Revit & Civil 3D drainage models)
    'IFCPIPESEGMENT', 'IFCPIPEFITTING', 'IFCDISTRIBUTIONCHAMBERELEMENT',
    'IFCDUCTSEGMENT', 'IFCDUCTFITTING', 'IFCCABLESEGMENT', 'IFCCABLECARRIERSEGMENT',
    'IFCCABLEFITTING', 'IFCCABLECARRIERFITTING', 'IFCJUNCTIONBOX',
    'IFCDISTRIBUTIONELEMENT', 'IFCDISTRIBUTIONFLOWELEMENT', 'IFCDISTRIBUTIONCONTROLELEMENT',
    'IFCFLOWSEGMENT', 'IFCFLOWTERMINAL', 'IFCFLOWFITTING', 'IFCFLOWCONTROLLER',
    'IFCFLOWMOVINGDEVICE', 'IFCFLOWSTORAGEELEMENT', 'IFCFLOWTREATMENTDEVICE',
    'IFCENERGYCONVERSIONDEVICE', 'IFCSANITARYTERMINAL', 'IFCWASTETERMINAL',
    'IFCFIRESUPPRESSIONTERMINAL', 'IFCLAMP', 'IFCLIGHTFIXTURE', 'IFCOUTLET',
    'IFCSENSOR', 'IFCACTUATOR', 'IFCALARM', 'IFCCONTROLLER', 'IFCUNITARYEQUIPMENT',
    // Railway, Road & Linear Infrastructure (IFC 4x3)
    'IFCTRACKELEMENT', 'IFCRAIL', 'IFCSLEEPER', 'IFCCOURSE', 'IFCPAVEMENT', 'IFCKERB',
    'IFCEARTHWORKSCUT', 'IFCEARTHWORKSFILL', 'IFCEARTHWORKSELEMENT', 'IFCREINFORCEDSOIL',
    'IFCSIGN', 'IFCSIGNAL', 'IFCBEARING', 'IFCDEEPFOUNDATION', 'IFCCAISSONFOUNDATION',
    'IFCRETAININGWALL', 'IFCMOORINGDEVICE', 'IFCNAVIGATIONELEMENT',
    'IFCTENDON', 'IFCTENDONANCHOR', 'IFCREINFORCINGBAR', 'IFCREINFORCINGMESH',
    'IFCSHADINGDEVICE', 'IFCCHIMNEY', 'IFCVIBRATIONISOLATOR'
  ]);

  const SPATIAL_CONTAINER_TYPES = new Set([
    'IFCPROJECT', 'IFCSITE', 'IFCBUILDING', 'IFCBUILDINGSTOREY', 'IFCSPACE',
    'IFCRAILWAY', 'IFCRAILWAYPART', 'IFCFACILITY', 'IFCFACILITYPART',
    'IFCBRIDGE', 'IFCBRIDGEPART', 'IFCROAD', 'IFCROADPART', 'IFCMARINEFACILITY',
    'IFCALIGNMENT', 'IFCREFERENT'
  ]);

  const MANDATORY_ADIF_PARAMS = [
    'ADIF_00_Codigo_Producto',
    'ADIF_02_Zonificacion',
    'ADIF_03_Codigo_Estado',
    'ADIF_03_Fuente_Definicion',
    'ADIF_04_Codigo_Actividad',
    'ADIF_05_Codigo_Partida'
  ];

  // ISO-10303-21 STEP String Unescaping (\X2\00D3\X0\ -> Ó, \X\E9 -> é)
  function decodeStep(str) {
    if (!str || typeof str !== 'string') return '';
    return str
      .replace(/\\X2\\([0-9A-Fa-f]+)\\X0\\/g, (_, hex) => {
        let out = '';
        for (let i = 0; i < hex.length; i += 4) {
          out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
        }
        return out;
      })
      .replace(/\\X\\([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/''/g, "'");
  }

  // Encode JS string back to ISO-10303-21 STEP string literal content
  function encodeStep(str) {
    if (str === null || str === undefined) return '';
    const s = String(str);
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      if (s[i] === "'") {
        out += "''";
      } else if (code >= 32 && code <= 126) {
        out += s[i];
      } else {
        out += '\\X2\\' + code.toString(16).toUpperCase().padStart(4, '0') + '\\X0\\';
      }
    }
    return out;
  }

  // Generate 22-char IFC Base64 GlobalId
  const IFC_B64 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';
  function generateIfcGuid() {
    let g = IFC_B64[Math.floor(Math.random() * 4)];
    for (let i = 1; i < 22; i++) {
      g += IFC_B64[Math.floor(Math.random() * 64)];
    }
    return g;
  }

  // Split top-level comma-separated STEP arguments respecting quotes and nested parentheses
  function splitStepArgs(argStr) {
    const res = [];
    let cur = '';
    let depth = 0;
    let inStr = false;
    for (let i = 0; i < argStr.length; i++) {
      const ch = argStr[i];
      if (ch === "'") {
        inStr = !inStr;
        cur += ch;
      } else if (!inStr) {
        if (ch === '(') {
          depth++;
          cur += ch;
        } else if (ch === ')') {
          depth--;
          cur += ch;
        } else if (ch === ',' && depth === 0) {
          res.push(cur.trim());
          cur = '';
        } else {
          cur += ch;
        }
      } else {
        cur += ch;
      }
    }
    if (cur.length > 0) res.push(cur.trim());
    return res;
  }

  function cleanStepToken(val) {
    if (!val || val === '$' || val === '*') return '';
    val = val.trim();
    if (val.startsWith("'") && val.endsWith("'")) {
      return decodeStep(val.slice(1, -1));
    }
    // Wrapped IFC value e.g. IFCTEXT('FUN.DRE.010.020') or IFCLENGTHMEASURE(1.887) or IFCBOOLEAN(.T.)
    const mWrap = val.match(/^[A-Z0-9_]+\((.*)\)$/i);
    if (mWrap) {
      return cleanStepToken(mWrap[1]);
    }
    if (val === '.T.') return 'True';
    if (val === '.F.') return 'False';
    if (val.startsWith('.') && val.endsWith('.')) return val.slice(1, -1);
    return decodeStep(val);
  }

  function extractIdRefs(str) {
    if (!str) return [];
    const ids = [];
    const re = /#(\d+)/g;
    let m;
    while ((m = re.exec(str)) !== null) {
      ids.push(parseInt(m[1], 10));
    }
    return ids;
  }

  function isMandatoryEmpty(val) {
    if (val === null || val === undefined) return true;
    const s = String(val).trim();
    if (!s) return true;
    const up = s.toUpperCase();
    return up === 'N/A' || up === 'NA' || up === 'NULL' || up === 'NONE' || up === '-' || up === '$';
  }

  // Extract header info matching _extract_ifc_info in backend/routers/ifc.py
  function parseHeaderInfo(text, filename, rawEntities) {
    const headerMatch = text.match(/HEADER;([\s\S]*?)ENDSEC;/i);
    const headerBlock = headerMatch ? headerMatch[1] : text.slice(0, 4000);

    let schema = 'IFC4';
    const sm = headerBlock.match(/FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'/i);
    if (sm) schema = sm[1].trim();

    let description = '';
    const dm = headerBlock.match(/FILE_DESCRIPTION\s*\(\s*\(\s*'([^']*)'/i);
    if (dm) description = decodeStep(dm[1]);

    let timestamp = '';
    let author = '';
    let organization = '';
    let preprocessor = '';
    let originatingSystem = '';
    let authorization = '';

    const fnMatch = headerBlock.match(/FILE_NAME\s*\(([\s\S]*?)\)\s*;/i);
    if (fnMatch) {
      const fnArgs = splitStepArgs(fnMatch[1]);
      if (fnArgs[1]) timestamp = cleanStepToken(fnArgs[1]);
      if (fnArgs[2]) {
        const aMatches = fnArgs[2].match(/'([^']*)'/g);
        author = aMatches ? aMatches.map(s => decodeStep(s.slice(1, -1))).filter(Boolean).join(' ') : cleanStepToken(fnArgs[2]);
      }
      if (fnArgs[3]) {
        const oMatches = fnArgs[3].match(/'([^']*)'/g);
        organization = oMatches ? oMatches.map(s => decodeStep(s.slice(1, -1))).filter(Boolean).join(' ') : cleanStepToken(fnArgs[3]);
      }
      if (fnArgs[4]) preprocessor = cleanStepToken(fnArgs[4]);
      if (fnArgs[5]) originatingSystem = cleanStepToken(fnArgs[5]);
      if (fnArgs[6]) authorization = cleanStepToken(fnArgs[6]);

      // Scan strings from index 4 onwards for software keywords (matching ifc.py lines 758-763)
      for (let i = 4; i < fnArgs.length; i++) {
        const s = cleanStepToken(fnArgs[i]);
        if (/revit|civil|archicad|tekla|ifcinfrageneric|allplan|bentley|ifcopenshell/i.test(s)) {
          originatingSystem = s;
          break;
        }
      }
    }

    // Fallback to IFCAPPLICATION if originatingSystem doesn't clearly specify RVT/C3D
    let appName = '';
    let appVersion = '';
    for (const id in rawEntities) {
      const e = rawEntities[id];
      if (e.type === 'IFCAPPLICATION') {
        const a = splitStepArgs(e.args);
        appVersion = cleanStepToken(a[1]);
        appName = cleanStepToken(a[2]) || cleanStepToken(a[3]);
        if (!originatingSystem && appName) originatingSystem = appName;
        break;
      }
    }

    // Detect RVT vs C3D source badge
    const sysLower = (originatingSystem + ' ' + appName + ' ' + filename).toLowerCase();
    let sourceBadge = 'IFC';
    if (sysLower.includes('revit') || filename.toUpperCase().includes('_RVT')) {
      sourceBadge = 'RVT';
    } else if (sysLower.includes('civil') || sysLower.includes('c3d') || filename.toUpperCase().includes('_C3D')) {
      sourceBadge = 'C3D';
    }

    // Extract CRS / MapConversion if present (IFC4 / IFC4X3)
    let crs = { name: '', description: '', geodeticDatum: '', mapZone: '', eastings: 0, northings: 0, orthogonalHeight: 0, scale: 1 };
    for (const id in rawEntities) {
      const e = rawEntities[id];
      if (e.type === 'IFCPROJECTEDCRS') {
        const a = splitStepArgs(e.args);
        crs.name = cleanStepToken(a[0]);
        crs.description = cleanStepToken(a[1]);
        crs.geodeticDatum = cleanStepToken(a[2]);
        crs.mapZone = cleanStepToken(a[4]);
      } else if (e.type === 'IFCMAPCONVERSION' || e.type === 'IFCRIGIDOPERATION') {
        const a = splitStepArgs(e.args);
        crs.eastings = parseFloat(cleanStepToken(a[2])) || 0;
        crs.northings = parseFloat(cleanStepToken(a[3])) || 0;
        crs.orthogonalHeight = parseFloat(cleanStepToken(a[4])) || 0;
        crs.scale = parseFloat(cleanStepToken(a[7])) || 1;
        crs.hasConversion = true;
      }
    }

    return {
      schema,
      description,
      timestamp,
      author,
      organization,
      preprocessor,
      originatingSystem: originatingSystem || appName || 'OpenBIM IFC Exporter',
      appName,
      appVersion,
      authorization,
      sourceBadge,
      crs
    };
  }

  // ── 3D MATRIX & GEOMETRY HELPERS ──────────────────────────────────────────
  function vec3Normalize(v) {
    const len = Math.hypot(v[0], v[1], v[2]);
    return len > 1e-12 ? [v[0] / len, v[1] / len, v[2] / len] : [0, 0, 1];
  }

  function vec3Cross(a, b) {
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0]
    ];
  }

  function vec3Dot(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  }

  function mat4Identity() {
    return [
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1
    ];
  }

  // Column-major 4x4 matrix multiplication: out = A * B
  function mat4Multiply(A, B) {
    const out = new Array(16).fill(0);
    for (let col = 0; col < 4; col++) {
      for (let row = 0; row < 4; row++) {
        out[col * 4 + row] =
          A[0 * 4 + row] * B[col * 4 + 0] +
          A[1 * 4 + row] * B[col * 4 + 1] +
          A[2 * 4 + row] * B[col * 4 + 2] +
          A[3 * 4 + row] * B[col * 4 + 3];
      }
    }
    return out;
  }

  function mat4TransformPoint(M, p) {
    return [
      M[0] * p[0] + M[4] * p[1] + M[8] * p[2] + M[12],
      M[1] * p[0] + M[5] * p[1] + M[9] * p[2] + M[13],
      M[2] * p[0] + M[6] * p[1] + M[10] * p[2] + M[14]
    ];
  }

  function mat4FromBasisAndOrigin(xAxis, yAxis, zAxis, origin) {
    return [
      xAxis[0], xAxis[1], xAxis[2], 0,
      yAxis[0], yAxis[1], yAxis[2], 0,
      zAxis[0], zAxis[1], zAxis[2], 0,
      origin[0], origin[1], origin[2], 1
    ];
  }

  // ── CORE PARSER ───────────────────────────────────────────────────────────
  function parseIfcStep(text, filename, sizeBytes) {
    const t0 = Date.now();
    const rawEntities = {};
    let maxStepId = 0;
    let defaultOwnerHistoryId = null;

    // 1. Single-pass scan over STEP lines
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.charCodeAt(0) !== 35) continue; // '#'
      const eqIdx = line.indexOf('=');
      if (eqIdx < 2) continue;
      const id = parseInt(line.slice(1, eqIdx), 10);
      if (isNaN(id)) continue;
      if (id > maxStepId) maxStepId = id;

      const rest = line.slice(eqIdx + 1).trim();
      const parenOpen = rest.indexOf('(');
      if (parenOpen < 1) continue;
      const type = rest.slice(0, parenOpen).trim().toUpperCase();
      const endParen = rest.lastIndexOf(')');
      if (endParen < parenOpen) continue;
      const args = rest.slice(parenOpen + 1, endParen);

      rawEntities[id] = { id, type, args };
      if (!defaultOwnerHistoryId && type === 'IFCOWNERHISTORY') {
        defaultOwnerHistoryId = id;
      }
    }

    const headerInfo = parseHeaderInfo(text, filename || 'Modelo.ifc', rawEntities);

    // 2. Geometry Primitives (Points & Directions) + Placement Matrices
    const points = {};
    const directions = {};
    for (const idStr in rawEntities) {
      const id = parseInt(idStr, 10);
      const e = rawEntities[id];
      if (e.type === 'IFCCARTESIANPOINT') {
        const m = e.args.match(/\(([^)]+)\)/);
        if (m) {
          const nums = m[1].split(',').map(Number);
          points[id] = [nums[0] || 0, nums[1] || 0, nums[2] || 0];
        }
      } else if (e.type === 'IFCDIRECTION') {
        const m = e.args.match(/\(([^)]+)\)/);
        if (m) {
          const nums = m[1].split(',').map(Number);
          directions[id] = [nums[0] || 0, nums[1] || 0, nums[2] || 0];
        }
      }
    }

    function getAxis2Placement3DMatrix(axisId) {
      const e = rawEntities[axisId];
      if (!e || e.type !== 'IFCAXIS2PLACEMENT3D') return mat4Identity();
      const a = splitStepArgs(e.args);
      const locId = a[0] && a[0].startsWith('#') ? parseInt(a[0].slice(1), 10) : null;
      const zId = a[1] && a[1].startsWith('#') ? parseInt(a[1].slice(1), 10) : null;
      const xId = a[2] && a[2].startsWith('#') ? parseInt(a[2].slice(1), 10) : null;

      const origin = (locId && points[locId]) ? points[locId] : [0, 0, 0];
      let zAxis = (zId && directions[zId]) ? vec3Normalize(directions[zId]) : [0, 0, 1];
      let refDir = (xId && directions[xId]) ? vec3Normalize(directions[xId]) : [1, 0, 0];

      // Orthonormalize (ISO 10303-42 Axis2Placement3D)
      const dot = vec3Dot(refDir, zAxis);
      let xAxis = vec3Normalize([
        refDir[0] - dot * zAxis[0],
        refDir[1] - dot * zAxis[1],
        refDir[2] - dot * zAxis[2]
      ]);
      if (Math.hypot(xAxis[0], xAxis[1], xAxis[2]) < 1e-9) {
        xAxis = Math.abs(zAxis[2]) < 0.9 ? vec3Normalize(vec3Cross([0, 0, 1], zAxis)) : [1, 0, 0];
      }
      const yAxis = vec3Normalize(vec3Cross(zAxis, xAxis));
      return mat4FromBasisAndOrigin(xAxis, yAxis, zAxis, origin);
    }

    const placementMatrixCache = {};
    function getLocalPlacementMatrix(lpId, depth = 0) {
      if (!lpId || depth > 20) return mat4Identity();
      if (placementMatrixCache[lpId]) return placementMatrixCache[lpId];
      const e = rawEntities[lpId];
      if (!e || e.type !== 'IFCLOCALPLACEMENT') return mat4Identity();
      const a = splitStepArgs(e.args);
      const parentId = a[0] && a[0].startsWith('#') ? parseInt(a[0].slice(1), 10) : null;
      const relId = a[1] && a[1].startsWith('#') ? parseInt(a[1].slice(1), 10) : null;
      const parentMat = parentId ? getLocalPlacementMatrix(parentId, depth + 1) : mat4Identity();
      const localMat = relId ? getAxis2Placement3DMatrix(relId) : mat4Identity();
      const worldMat = mat4Multiply(parentMat, localMat);
      placementMatrixCache[lpId] = worldMat;
      return worldMat;
    }

    // 3. Parse Properties & PropertySets
    const singleProps = {};
    const psets = {};
    const typeObjects = {};
    const materials = {};
    const classifications = {};
    const classRefs = {};
    const systems = {};

    for (const idStr in rawEntities) {
      const id = parseInt(idStr, 10);
      const e = rawEntities[id];
      const t = e.type;

      if (t === 'IFCPROPERTYSINGLEVALUE') {
        const a = splitStepArgs(e.args);
        if (a.length >= 3) {
          singleProps[id] = {
            id,
            name: cleanStepToken(a[0]),
            val: cleanStepToken(a[2]),
            rawValToken: a[2]
          };
        }
      } else if (t === 'IFCPROPERTYENUMERATEDVALUE') {
        const a = splitStepArgs(e.args);
        if (a.length >= 2) {
          const vals = splitStepArgs(a[2].replace(/^\(|\)$/g, '')).map(cleanStepToken).join(', ');
          singleProps[id] = { id, name: cleanStepToken(a[0]), val: vals, rawValToken: a[2] };
        }
      } else if (t === 'IFCMATERIAL') {
        const a = splitStepArgs(e.args);
        materials[id] = {
          id,
          name: cleanStepToken(a[0]) || 'Unnamed',
          category: cleanStepToken(a[2]) || ''
        };
      } else if (t === 'IFCCLASSIFICATION') {
        const a = splitStepArgs(e.args);
        classifications[id] = {
          id,
          source: cleanStepToken(a[0]),
          edition: cleanStepToken(a[1]),
          editionDate: cleanStepToken(a[2]),
          name: cleanStepToken(a[3]) || 'Classification',
          location: cleanStepToken(a[5])
        };
      } else if (t === 'IFCCLASSIFICATIONREFERENCE') {
        const a = splitStepArgs(e.args);
        const refSourceId = a[3] && a[3].startsWith('#') ? parseInt(a[3].slice(1), 10) : null;
        classRefs[id] = {
          id,
          location: cleanStepToken(a[0]),
          identification: cleanStepToken(a[1]),
          name: cleanStepToken(a[2]),
          referencedSourceId: refSourceId
        };
      } else if (t === 'IFCSYSTEM' || t === 'IFCGROUP' || t === 'IFCZONE') {
        const a = splitStepArgs(e.args);
        systems[id] = {
          id,
          type: t,
          guid: cleanStepToken(a[0]),
          name: cleanStepToken(a[2]) || `${t}_${id}`,
          description: cleanStepToken(a[3]),
          objectType: cleanStepToken(a[4]),
          memberIds: []
        };
      } else if (t.endsWith('TYPE') || t.endsWith('STYLE')) {
        // e.g. IFCPIPESEGMENTTYPE('guid',#18,'IDR_DPR_TuboDrenajePVC',$,$,(#1331,#1332,#1333),(#1066),'1511617',$,.CULVERT.)
        const a = splitStepArgs(e.args);
        if (a.length >= 6) {
          typeObjects[id] = {
            id,
            type: t,
            guid: cleanStepToken(a[0]),
            name: cleanStepToken(a[2]),
            psetIds: extractIdRefs(a[5]),
            repMapIds: a[6] ? extractIdRefs(a[6]) : [],
            tag: cleanStepToken(a[7])
          };
        }
      }
    }

    // Resolve composite material sets (IFCMATERIALCONSTITUENTSET, IFCMATERIALLAYERSETUSAGE, IFCMATERIALLIST)
    for (const idStr in rawEntities) {
      const id = parseInt(idStr, 10);
      const e = rawEntities[id];
      if (e.type === 'IFCMATERIALCONSTITUENT' || e.type === 'IFCMATERIALLAYER' || e.type === 'IFCMATERIALPROFILE') {
        const refs = extractIdRefs(e.args);
        for (const r of refs) {
          if (materials[r]) {
            materials[id] = { id, name: materials[r].name, category: materials[r].category, targetMatId: r };
            break;
          }
        }
      }
    }
    for (const idStr in rawEntities) {
      const id = parseInt(idStr, 10);
      const e = rawEntities[id];
      if (
        e.type === 'IFCMATERIALCONSTITUENTSET' ||
        e.type === 'IFCMATERIALLAYERSET' ||
        e.type === 'IFCMATERIALLAYERSETUSAGE' ||
        e.type === 'IFCMATERIALLIST' ||
        e.type === 'IFCMATERIALPROFILESET' ||
        e.type === 'IFCMATERIALPROFILESETUSAGE'
      ) {
        const a = splitStepArgs(e.args);
        const setName = cleanStepToken(a[0]);
        const refs = extractIdRefs(e.args);
        const names = [];
        let primaryMatId = null;
        for (const r of refs) {
          if (materials[r]) {
            if (!primaryMatId) primaryMatId = materials[r].targetMatId || r;
            if (materials[r].name && !names.includes(materials[r].name)) {
              names.push(materials[r].name);
            }
          }
        }
        materials[id] = {
          id,
          name: (setName && setName !== '$' && !setName.startsWith('#')) ? setName : (names.join(' + ') || 'Material Compuesto'),
          category: 'Composite',
          targetMatId: primaryMatId || id
        };
      }
    }

    // Build PropertySet map
    for (const idStr in rawEntities) {
      const id = parseInt(idStr, 10);
      const e = rawEntities[id];
      if (e.type === 'IFCPROPERTYSET') {
        const a = splitStepArgs(e.args);
        if (a.length >= 5) {
          const pName = cleanStepToken(a[2]) || 'Pset';
          const propIds = extractIdRefs(a[4]);
          const props = {};
          const propMeta = {};
          for (const pid of propIds) {
            if (singleProps[pid]) {
              props[singleProps[pid].name] = singleProps[pid].val;
              propMeta[singleProps[pid].name] = singleProps[pid].id;
            }
          }
          psets[id] = { id, name: pName, props, propMeta };
        }
      } else if (e.type === 'IFCELEMENTQUANTITY') {
        const a = splitStepArgs(e.args);
        if (a.length >= 5) {
          const qName = cleanStepToken(a[2]) || 'BaseQuantities';
          const qIds = extractIdRefs(a[5] || a[4]);
          const props = {};
          for (const qid of qIds) {
            const qe = rawEntities[qid];
            if (qe && qe.type.startsWith('IFCQUANTITY')) {
              const qa = splitStepArgs(qe.args);
              props[cleanStepToken(qa[0])] = cleanStepToken(qa[3]);
            }
          }
          psets[id] = { id, name: qName, props, propMeta: {} };
        }
      }
    }

    // 4. Parse Spatial Containers & Physical Elements
    const spatialNodes = {};
    const elements = [];
    const elementById = {};
    let projectNodeId = null;
    let siteNodeId = null;

    for (const idStr in rawEntities) {
      const id = parseInt(idStr, 10);
      const e = rawEntities[id];
      const t = e.type;

      if (SPATIAL_CONTAINER_TYPES.has(t)) {
        const a = splitStepArgs(e.args);
        const guid = cleanStepToken(a[0]);
        const name = cleanStepToken(a[2]) || cleanStepToken(a[7]) || t;
        const desc = cleanStepToken(a[3]);
        const longName = cleanStepToken(a[7]);
        const lpId = (a[5] && a[5].startsWith('#')) ? parseInt(a[5].slice(1), 10) : null;
        spatialNodes[id] = {
          id,
          type: t,
          guid,
          name,
          longName,
          description: desc,
          lpId,
          children: [],
          elements: [],
          psets: {}
        };
        if (t === 'IFCPROJECT') projectNodeId = id;
        if (t === 'IFCSITE') siteNodeId = id;
      } else if (PHYSICAL_IFC_TYPES.has(t)) {
        const a = splitStepArgs(e.args);
        const guid = cleanStepToken(a[0]);
        const name = cleanStepToken(a[2]) || `${t}_${id}`;
        const desc = cleanStepToken(a[3]);
        const objectType = cleanStepToken(a[4]);
        const lpId = (a[5] && a[5].startsWith('#')) ? parseInt(a[5].slice(1), 10) : null;
        const prodShapeId = (a[6] && a[6].startsWith('#')) ? parseInt(a[6].slice(1), 10) : null;
        const tag = cleanStepToken(a[7]);
        const predefinedType = cleanStepToken(a[8]);

        const worldMat = lpId ? getLocalPlacementMatrix(lpId) : mat4Identity();
        const pos = [worldMat[12], worldMat[13], worldMat[14]];

        const el = {
          id,
          type: t,
          guid,
          name,
          description: desc,
          objectType,
          lpId,
          prodShapeId,
          tag,
          predefinedType,
          worldMat,
          pos,
          storeyId: null,
          storey: 'Sin Nivel Asignado',
          material: 'Sin Material',
          materialId: null,
          typeObjectId: null,
          typeObjectName: '',
          classifications: [],
          systems: [],
          psets: {},
          propStepIds: {},
          lengthM: 0,
          volumeM3: 0
        };
        elements.push(el);
        elementById[id] = el;
      }
    }

    // 5. Parse Relationships (IFCRELDEFINESBYPROPERTIES, IFCRELDEFINESBYTYPE, IFCRELASSOCIATESMATERIAL, IFCRELASSOCIATESCLASSIFICATION, IFCRELCONTAINEDINSPATIALSTRUCTURE, IFCRELAGGREGATES, IFCRELASSIGNSTOGROUP)
    function mergePsetIntoTarget(targetPsets, targetPropStepIds, psetObj) {
      if (!psetObj) return;
      if (!targetPsets[psetObj.name]) {
        targetPsets[psetObj.name] = {};
      }
      Object.assign(targetPsets[psetObj.name], psetObj.props);
      if (targetPropStepIds && psetObj.propMeta) {
        if (!targetPropStepIds[psetObj.name]) targetPropStepIds[psetObj.name] = {};
        Object.assign(targetPropStepIds[psetObj.name], psetObj.propMeta);
      }
    }

    // First pass: Type relationships so elements inherit Type Psets before Instance Psets override them
    const typeMaterialMap = {};
    for (const idStr in rawEntities) {
      const e = rawEntities[idStr];
      if (e.type === 'IFCRELASSOCIATESMATERIAL') {
        const a = splitStepArgs(e.args);
        if (a.length >= 6) {
          const relatedIds = extractIdRefs(a[4]);
          const matRefIds = extractIdRefs(a[5]);
          const matId = matRefIds[matRefIds.length - 1];
          const matObj = materials[matId];
          if (matObj) {
            for (const rid of relatedIds) {
              if (typeObjects[rid]) {
                typeMaterialMap[rid] = matObj;
              } else if (elementById[rid]) {
                elementById[rid].material = matObj.name;
                elementById[rid].materialId = matObj.targetMatId || matObj.id;
              }
            }
          }
        }
      }
    }

    for (const idStr in rawEntities) {
      const e = rawEntities[idStr];
      if (e.type === 'IFCRELDEFINESBYTYPE') {
        const a = splitStepArgs(e.args);
        if (a.length >= 6) {
          const relatedIds = extractIdRefs(a[4]);
          const typeIds = extractIdRefs(a[5]);
          const typeObj = typeObjects[typeIds[0]];
          if (typeObj) {
            for (const rid of relatedIds) {
              const el = elementById[rid];
              if (el) {
                el.typeObjectId = typeObj.id;
                el.typeObjectName = typeObj.name;
                for (const pid of typeObj.psetIds) {
                  mergePsetIntoTarget(el.psets, el.propStepIds, psets[pid]);
                }
                if (el.material === 'Sin Material' && typeMaterialMap[typeObj.id]) {
                  el.material = typeMaterialMap[typeObj.id].name;
                  el.materialId = typeMaterialMap[typeObj.id].targetMatId || typeMaterialMap[typeObj.id].id;
                }
              }
            }
          }
        }
      }
    }

    // Second pass: Instance Psets, Spatial Structure, Aggregates, Classifications, Systems
    for (const idStr in rawEntities) {
      const e = rawEntities[idStr];
      const t = e.type;

      if (t === 'IFCRELDEFINESBYPROPERTIES') {
        const a = splitStepArgs(e.args);
        if (a.length >= 6) {
          const relatedIds = extractIdRefs(a[4]);
          const psetIds = extractIdRefs(a[5]);
          const psetObj = psets[psetIds[0]];
          if (psetObj) {
            for (const rid of relatedIds) {
              if (elementById[rid]) {
                mergePsetIntoTarget(elementById[rid].psets, elementById[rid].propStepIds, psetObj);
              } else if (spatialNodes[rid]) {
                mergePsetIntoTarget(spatialNodes[rid].psets, null, psetObj);
              }
            }
          }
        }
      } else if (t === 'IFCRELCONTAINEDINSPATIALSTRUCTURE') {
        const a = splitStepArgs(e.args);
        if (a.length >= 6) {
          const relatedIds = extractIdRefs(a[4]);
          const containerIds = extractIdRefs(a[5]);
          const container = spatialNodes[containerIds[0]];
          if (container) {
            for (const rid of relatedIds) {
              if (elementById[rid]) {
                elementById[rid].storeyId = container.id;
                elementById[rid].storey = container.name;
                container.elements.push(rid);
              }
            }
          }
        }
      } else if (t === 'IFCRELAGGREGATES') {
        const a = splitStepArgs(e.args);
        if (a.length >= 6) {
          const parentIds = extractIdRefs(a[4]);
          const childIds = extractIdRefs(a[5]);
          const parent = spatialNodes[parentIds[0]];
          if (parent) {
            for (const cid of childIds) {
              if (spatialNodes[cid]) {
                parent.children.push(cid);
              } else if (elementById[cid]) {
                elementById[cid].storeyId = parent.id;
                elementById[cid].storey = parent.name;
                parent.elements.push(cid);
              }
            }
          }
        }
      } else if (t === 'IFCRELASSOCIATESCLASSIFICATION') {
        const a = splitStepArgs(e.args);
        if (a.length >= 6) {
          const relatedIds = extractIdRefs(a[4]);
          const refIds = extractIdRefs(a[5]);
          const cref = classRefs[refIds[0]];
          if (cref) {
            const sysObj = classifications[cref.referencedSourceId];
            const entry = {
              refId: cref.id,
              code: cref.identification,
              name: cref.name,
              system: sysObj ? sysObj.name : 'SCFClass_Funciones',
              location: cref.location
            };
            for (const rid of relatedIds) {
              if (elementById[rid]) {
                elementById[rid].classifications.push(entry);
              }
            }
          }
        }
      } else if (t === 'IFCRELASSIGNSTOGROUP') {
        const a = splitStepArgs(e.args);
        if (a.length >= 6) {
          const relatedIds = extractIdRefs(a[4]);
          const groupIds = extractIdRefs(a[5]);
          const grp = systems[groupIds[0]];
          if (grp) {
            for (const rid of relatedIds) {
              if (elementById[rid]) {
                grp.memberIds.push(rid);
                elementById[rid].systems.push(grp.name);
              }
            }
          }
        }
      }
    }

    // 6. Post-process Elements: Flatten lookup helpers, extract length/volume, check 6 mandatory ADIF parameters
    let mandatoryCompleteElements = 0;
    let totalMandatoryFilled = 0;
    const mandatoryParamStats = {};
    for (const p of MANDATORY_ADIF_PARAMS) {
      mandatoryParamStats[p] = { filled: 0, empty: 0, values: {} };
    }

    for (const el of elements) {
      // Build flat property lookup across all Psets
      const flatProps = {};
      for (const psetName in el.psets) {
        const pObj = el.psets[psetName];
        for (const k in pObj) {
          if (flatProps[k] === undefined || isMandatoryEmpty(flatProps[k])) {
            flatProps[k] = pObj[k];
          }
        }
      }
      el.flatProps = flatProps;

      // Fallback material from Pset if not assigned via IfcRelAssociatesMaterial
      if (el.material === 'Sin Material' || el.material === 'N/A' || el.material === '<Unnamed>') {
        const pMat = flatProps['Material'] || flatProps['MAT_Prop'] || flatProps['Material estructural'];
        if (pMat && !isMandatoryEmpty(pMat)) {
          el.material = pMat;
        }
      }

      // Extract Length / Volume from properties if available
      const lenVal = parseFloat(flatProps['Length'] || flatProps['Longitud'] || flatProps['ADIF_01_Longitud'] || 0);
      if (!isNaN(lenVal) && lenVal > 0) el.lengthM = lenVal;
      const volVal = parseFloat(flatProps['NetVolume'] || flatProps['Volume'] || flatProps['Volumen'] || 0);
      if (!isNaN(volVal) && volVal > 0) el.volumeM3 = volVal;

      // Evaluate 6 mandatory ADIF parameters (matching _check_mandatory_params_status in ifc.py)
      let elFilledCount = 0;
      el.mandatoryStatus = {};
      for (const mp of MANDATORY_ADIF_PARAMS) {
        const v = flatProps[mp];
        const empty = isMandatoryEmpty(v);
        el.mandatoryStatus[mp] = empty ? null : String(v).trim();
        if (!empty) {
          elFilledCount++;
          totalMandatoryFilled++;
          mandatoryParamStats[mp].filled++;
          const sv = String(v).trim();
          mandatoryParamStats[mp].values[sv] = (mandatoryParamStats[mp].values[sv] || 0) + 1;
        } else {
          mandatoryParamStats[mp].empty++;
        }
      }
      el.mandatoryFilledCount = elFilledCount;
      el.mandatoryComplete = (elFilledCount === MANDATORY_ADIF_PARAMS.length);
      if (el.mandatoryComplete) mandatoryCompleteElements++;
    }

    // Collect Project & Site Global Psets (for Project Defaults & PEB Generator)
    const projectDefaults = {};
    if (projectNodeId && spatialNodes[projectNodeId]) {
      for (const psName in spatialNodes[projectNodeId].psets) {
        Object.assign(projectDefaults, spatialNodes[projectNodeId].psets[psName]);
      }
    }
    if (siteNodeId && spatialNodes[siteNodeId]) {
      for (const psName in spatialNodes[siteNodeId].psets) {
        for (const k in spatialNodes[siteNodeId].psets[psName]) {
          if (!projectDefaults[k]) projectDefaults[k] = spatialNodes[siteNodeId].psets[psName][k];
        }
      }
    }

    const totalPossibleMandatory = elements.length * MANDATORY_ADIF_PARAMS.length;
    const mandatoryCompliancePct = totalPossibleMandatory > 0
      ? Math.round((totalMandatoryFilled / totalPossibleMandatory) * 1000) / 10
      : 0;

    return {
      filename: filename || 'Modelo.ifc',
      sizeBytes: sizeBytes || text.length,
      rawText: text,
      parseTimeMs: Date.now() - t0,
      maxStepId,
      defaultOwnerHistoryId,
      projectNodeId,
      siteNodeId,
      header: headerInfo,
      schema: headerInfo.schema,
      app: headerInfo.originatingSystem,
      sourceBadge: headerInfo.sourceBadge,
      projectDefaults,
      spatialNodes,
      elements,
      elementById,
      materials,
      classifications,
      classRefs,
      systems,
      typeObjects,
      psets,
      singleProps,
      rawEntities,
      points,
      directions,
      getLocalPlacementMatrix,
      getAxis2Placement3DMatrix,
      mandatoryParamStats,
      mandatoryCompliancePct,
      mandatoryCompleteElements
    };
  }

  // ── 3D GEOMETRY EXTRACTOR (Tessellation + SweptSolid + Brep + MappedItem) ──
  function extractModel3DGeometry(model) {
    const rawEntities = model.rawEntities;
    const points = model.points;
    const directions = model.directions;

    // 1. Parse IFCCARTESIANPOINTLIST3D for Civil 3D Tessellation
    const pointLists3D = {};
    for (const idStr in rawEntities) {
      const id = parseInt(idStr, 10);
      const e = rawEntities[id];
      if (e.type === 'IFCCARTESIANPOINTLIST3D') {
        const coords = [];
        const re = /\(\s*([+-]?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)\s*,\s*([+-]?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)\s*,\s*([+-]?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)\s*\)/g;
        let m;
        while ((m = re.exec(e.args)) !== null) {
          coords.push([parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])]);
        }
        pointLists3D[id] = coords;
      }
    }

    // 2. Parse Surface Styles / Colors (IFCCOLOURRGB -> IFCSURFACESTYLERENDERING -> IFCSURFACESTYLE -> IFCSTYLEDITEM)
    const rgbColors = {};
    const styleColors = {};
    const itemColors = {};
    for (const idStr in rawEntities) {
      const id = parseInt(idStr, 10);
      const e = rawEntities[id];
      if (e.type === 'IFCCOLOURRGB') {
        const a = splitStepArgs(e.args);
        rgbColors[id] = [parseFloat(a[1]) || 0.7, parseFloat(a[2]) || 0.75, parseFloat(a[3]) || 0.8];
      }
    }
    for (const idStr in rawEntities) {
      const id = parseInt(idStr, 10);
      const e = rawEntities[id];
      if (e.type === 'IFCSURFACESTYLERENDERING' || e.type === 'IFCSURFACESTYLESHADING') {
        const refs = extractIdRefs(e.args);
        if (refs[0] && rgbColors[refs[0]]) styleColors[id] = rgbColors[refs[0]];
      }
    }
    for (const idStr in rawEntities) {
      const id = parseInt(idStr, 10);
      const e = rawEntities[id];
      if (e.type === 'IFCSURFACESTYLE') {
        const refs = extractIdRefs(e.args);
        for (const r of refs) {
          if (styleColors[r]) {
            styleColors[id] = styleColors[r];
            break;
          }
        }
      }
    }
    for (const idStr in rawEntities) {
      const id = parseInt(idStr, 10);
      const e = rawEntities[id];
      if (e.type === 'IFCSTYLEDITEM') {
        const a = splitStepArgs(e.args);
        const targetId = a[0] && a[0].startsWith('#') ? parseInt(a[0].slice(1), 10) : null;
        const styleRefs = extractIdRefs(a[1]);
        if (targetId) {
          for (const sr of styleRefs) {
            if (styleColors[sr]) {
              itemColors[targetId] = styleColors[sr];
              break;
            }
          }
        }
      }
    }

    // Helper: Build local mesh (vertices flat [x,y,z,...], indices [i,j,k,...]) from a representation item
    const repItemCache = {};

    function getProfile2DLoop(profileId, segments = 12) {
      const pe = rawEntities[profileId];
      if (!pe) return [[ -0.05, -0.05 ], [ 0.05, -0.05 ], [ 0.05, 0.05 ], [ -0.05, 0.05 ]];
      const a = splitStepArgs(pe.args);
      if (pe.type === 'IFCCIRCLEPROFILEDEF' || pe.type === 'IFCCIRCLEHOLLOWPROFILEDEF') {
        const r = Math.max(0.02, parseFloat(a[3]) || 0.08);
        const loop = [];
        for (let i = 0; i < segments; i++) {
          const ang = (i / segments) * Math.PI * 2;
          loop.push([Math.cos(ang) * r, Math.sin(ang) * r]);
        }
        return loop;
      } else if (pe.type === 'IFCRECTANGLEPROFILEDEF' || pe.type === 'IFCRECTANGLEHOLLOWPROFILEDEF') {
        const xDim = (parseFloat(a[3]) || 0.4) / 2;
        const yDim = (parseFloat(a[4]) || 0.4) / 2;
        return [[-xDim, -yDim], [xDim, -yDim], [xDim, yDim], [-xDim, yDim]];
      } else if (pe.type === 'IFCARBITRARYCLOSEDPROFILEDEF') {
        const curveId = a[2] && a[2].startsWith('#') ? parseInt(a[2].slice(1), 10) : null;
        const ce = curveId ? rawEntities[curveId] : null;
        if (ce && ce.type === 'IFCPOLYLINE') {
          const ptIds = extractIdRefs(ce.args);
          const loop = [];
          for (const pid of ptIds) {
            if (points[pid]) loop.push([points[pid][0], points[pid][1]]);
          }
          if (loop.length >= 3) return loop;
        }
      }
      return [[-0.1, -0.1], [0.1, -0.1], [0.1, 0.1], [-0.1, 0.1]];
    }

    function extractGeometryItem(itemId, depth = 0) {
      if (!itemId || depth > 8) return null;
      if (repItemCache[itemId]) return repItemCache[itemId];
      const e = rawEntities[itemId];
      if (!e) return null;

      let result = null;

      if (e.type === 'IFCTRIANGULATEDFACESET') {
        // #253=IFCTRIANGULATEDFACESET(#254,$,.T.,((1,2,3),(2,1,4),...),$);
        const a = splitStepArgs(e.args);
        const coordListId = a[0] && a[0].startsWith('#') ? parseInt(a[0].slice(1), 10) : null;
        const ptList = coordListId ? pointLists3D[coordListId] : null;
        if (ptList && ptList.length > 0 && a[3]) {
          const verts = [];
          for (let i = 0; i < ptList.length; i++) {
            verts.push(ptList[i][0], ptList[i][1], ptList[i][2]);
          }
          const indices = [];
          const triRe = /\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/g;
          let tm;
          while ((tm = triRe.exec(a[3])) !== null) {
            indices.push(parseInt(tm[1], 10) - 1, parseInt(tm[2], 10) - 1, parseInt(tm[3], 10) - 1);
          }
          result = { verts, indices, color: itemColors[itemId] || null };
        }
      } else if (e.type === 'IFCEXTRUDEDAREASOLID') {
        // #1173=IFCEXTRUDEDAREASOLID(#1169,#1172,#9,1.8875344234517815);
        const a = splitStepArgs(e.args);
        const profileId = a[0] && a[0].startsWith('#') ? parseInt(a[0].slice(1), 10) : null;
        const posAxisId = a[1] && a[1].startsWith('#') ? parseInt(a[1].slice(1), 10) : null;
        const dirId = a[2] && a[2].startsWith('#') ? parseInt(a[2].slice(1), 10) : null;
        const depthVal = Math.max(0.02, parseFloat(a[3]) || 1.0);

        const loop2D = getProfile2DLoop(profileId, 10);
        const solidMat = posAxisId ? model.getAxis2Placement3DMatrix(posAxisId) : mat4Identity();
        const extDir = (dirId && directions[dirId]) ? vec3Normalize(directions[dirId]) : [0, 0, 1];
        const dx = extDir[0] * depthVal;
        const dy = extDir[1] * depthVal;
        const dz = extDir[2] * depthVal;

        const n = loop2D.length;
        const verts = [];
        const indices = [];
        // Bottom ring (0..n-1) and Top ring (n..2n-1)
        for (let i = 0; i < n; i++) {
          const pBot = mat4TransformPoint(solidMat, [loop2D[i][0], loop2D[i][1], 0]);
          verts.push(pBot[0], pBot[1], pBot[2]);
        }
        for (let i = 0; i < n; i++) {
          const pTop = mat4TransformPoint(solidMat, [loop2D[i][0] + dx, loop2D[i][1] + dy, dz]);
          verts.push(pTop[0], pTop[1], pTop[2]);
        }
        // Side quads
        for (let i = 0; i < n; i++) {
          const next = (i + 1) % n;
          indices.push(i, next, n + next);
          indices.push(i, n + next, n + i);
        }
        // Cap ends
        for (let i = 1; i < n - 1; i++) {
          indices.push(0, i + 1, i);
          indices.push(n, n + i, n + i + 1);
        }
        result = { verts, indices, color: itemColors[itemId] || null, lengthM: depthVal };
      } else if (e.type === 'IFCSURFACECURVESWEPTAREASOLID' || e.type === 'IFCSWEPTDISKSOLID') {
        const a = splitStepArgs(e.args);
        const profileId = a[0] && a[0].startsWith('#') ? parseInt(a[0].slice(1), 10) : null;
        const posAxisId = a[1] && a[1].startsWith('#') ? parseInt(a[1].slice(1), 10) : null;
        const loop2D = getProfile2DLoop(profileId, 10);
        const solidMat = posAxisId ? model.getAxis2Placement3DMatrix(posAxisId) : mat4Identity();
        const n = loop2D.length;
        const verts = [];
        const indices = [];
        const depthVal = 0.25;
        for (let i = 0; i < n; i++) {
          const pBot = mat4TransformPoint(solidMat, [loop2D[i][0], loop2D[i][1], 0]);
          verts.push(pBot[0], pBot[1], pBot[2]);
        }
        for (let i = 0; i < n; i++) {
          const pTop = mat4TransformPoint(solidMat, [loop2D[i][0], loop2D[i][1], depthVal]);
          verts.push(pTop[0], pTop[1], pTop[2]);
        }
        for (let i = 0; i < n; i++) {
          const next = (i + 1) % n;
          indices.push(i, next, n + next, i, n + next, n + i);
        }
        result = { verts, indices, color: itemColors[itemId] || null };
      } else if (e.type === 'IFCFACETEDBREP') {
        const shellIds = extractIdRefs(e.args);
        const shell = shellIds[0] ? rawEntities[shellIds[0]] : null;
        if (shell) {
          const faceIds = extractIdRefs(shell.args);
          const verts = [];
          const indices = [];
          const ptIndexMap = {};
          let vCount = 0;
          // Limit faces per Brep if huge survey symbol, though 260 faces is tiny
          for (const fid of faceIds) {
            const fe = rawEntities[fid];
            if (!fe) continue;
            const boundIds = extractIdRefs(fe.args);
            for (const bid of boundIds) {
              const be = rawEntities[bid];
              if (!be) continue;
              const loopIds = extractIdRefs(be.args);
              const le = loopIds[0] ? rawEntities[loopIds[0]] : null;
              if (!le || le.type !== 'IFCPOLYLOOP') continue;
              const pids = extractIdRefs(le.args);
              if (pids.length < 3) continue;
              const faceVertIdxs = [];
              for (const pid of pids) {
                if (ptIndexMap[pid] === undefined) {
                  const pt = points[pid] || [0, 0, 0];
                  ptIndexMap[pid] = vCount++;
                  verts.push(pt[0], pt[1], pt[2]);
                }
                faceVertIdxs.push(ptIndexMap[pid]);
              }
              for (let k = 1; k < faceVertIdxs.length - 1; k++) {
                indices.push(faceVertIdxs[0], faceVertIdxs[k], faceVertIdxs[k + 1]);
              }
            }
          }
          if (verts.length > 0 && indices.length > 0) {
            result = { verts, indices, color: itemColors[itemId] || null };
          }
        }
      } else if (e.type === 'IFCMAPPEDITEM') {
        // #1075=IFCMAPPEDITEM(#1066,#1074); -> #1066=IFCREPRESENTATIONMAP(#1065,#1064);
        const a = splitStepArgs(e.args);
        const repMapId = a[0] && a[0].startsWith('#') ? parseInt(a[0].slice(1), 10) : null;
        const rm = repMapId ? rawEntities[repMapId] : null;
        if (rm && rm.type === 'IFCREPRESENTATIONMAP') {
          const rma = splitStepArgs(rm.args);
          const shapeRepId = rma[1] && rma[1].startsWith('#') ? parseInt(rma[1].slice(1), 10) : null;
          result = extractShapeRepresentation(shapeRepId, depth + 1);
        }
      } else if (e.type === 'IFCBOOLEANCLIPPINGRESULT' || e.type === 'IFCBOOLEANRESULT') {
        const a = splitStepArgs(e.args);
        const firstOpId = a[1] && a[1].startsWith('#') ? parseInt(a[1].slice(1), 10) : null;
        result = extractGeometryItem(firstOpId, depth + 1);
      }

      repItemCache[itemId] = result;
      return result;
    }

    function extractShapeRepresentation(shapeRepId, depth = 0) {
      const sr = rawEntities[shapeRepId];
      if (!sr || sr.type !== 'IFCSHAPEREPRESENTATION') return null;
      const a = splitStepArgs(sr.args);
      const repType = cleanStepToken(a[1]);
      if (repType === 'Axis' || repType === 'Box' || repType === 'FootPrint') return null;
      const itemIds = extractIdRefs(a[3]);
      const combinedVerts = [];
      const combinedIndices = [];
      let color = null;
      let lengthM = 0;

      for (const iid of itemIds) {
        const g = extractGeometryItem(iid, depth + 1);
        if (g && g.verts && g.verts.length > 0) {
          const offset = combinedVerts.length / 3;
          for (let i = 0; i < g.verts.length; i++) combinedVerts.push(g.verts[i]);
          for (let i = 0; i < g.indices.length; i++) combinedIndices.push(g.indices[i] + offset);
          if (!color && g.color) color = g.color;
          if (g.lengthM) lengthM += g.lengthM;
        }
      }
      if (combinedVerts.length === 0) return null;
      return { verts: combinedVerts, indices: combinedIndices, color, lengthM };
    }

    // Extract world-space meshes & bounding boxes for all physical elements
    const meshes = [];
    let globalMin = [Infinity, Infinity, Infinity];
    let globalMax = [-Infinity, -Infinity, -Infinity];

    for (const el of model.elements) {
      let localGeom = null;
      if (el.prodShapeId && rawEntities[el.prodShapeId]) {
        const pds = rawEntities[el.prodShapeId];
        const a = splitStepArgs(pds.args);
        const srIds = extractIdRefs(a[2]);
        for (const srid of srIds) {
          const g = extractShapeRepresentation(srid, 0);
          if (g) {
            localGeom = g;
            break;
          }
        }
      }

      if (localGeom && localGeom.verts.length > 0) {
        const worldVerts = new Float32Array(localGeom.verts.length);
        let bMin = [Infinity, Infinity, Infinity];
        let bMax = [-Infinity, -Infinity, -Infinity];
        const M = el.worldMat;

        for (let i = 0; i < localGeom.verts.length; i += 3) {
          const wx = M[0] * localGeom.verts[i] + M[4] * localGeom.verts[i + 1] + M[8] * localGeom.verts[i + 2] + M[12];
          const wy = M[1] * localGeom.verts[i] + M[5] * localGeom.verts[i + 1] + M[9] * localGeom.verts[i + 2] + M[13];
          const wz = M[2] * localGeom.verts[i] + M[6] * localGeom.verts[i + 1] + M[10] * localGeom.verts[i + 2] + M[14];
          worldVerts[i] = wx;
          worldVerts[i + 1] = wy;
          worldVerts[i + 2] = wz;

          if (wx < bMin[0]) bMin[0] = wx;
          if (wy < bMin[1]) bMin[1] = wy;
          if (wz < bMin[2]) bMin[2] = wz;
          if (wx > bMax[0]) bMax[0] = wx;
          if (wy > bMax[1]) bMax[1] = wy;
          if (wz > bMax[2]) bMax[2] = wz;
        }

        const centroid = [
          (bMin[0] + bMax[0]) * 0.5,
          (bMin[1] + bMax[1]) * 0.5,
          (bMin[2] + bMax[2]) * 0.5
        ];
        el.centroid = centroid;
        el.bbox = { min: bMin, max: bMax };
        if (!el.lengthM && localGeom.lengthM) el.lengthM = localGeom.lengthM;
        if (!el.volumeM3) {
          const dx = Math.max(0.05, bMax[0] - bMin[0]);
          const dy = Math.max(0.05, bMax[1] - bMin[1]);
          const dz = Math.max(0.05, bMax[2] - bMin[2]);
          el.volumeM3 = Math.round(dx * dy * dz * 1000) / 1000;
        }

        for (let d = 0; d < 3; d++) {
          if (bMin[d] < globalMin[d]) globalMin[d] = bMin[d];
          if (bMax[d] > globalMax[d]) globalMax[d] = bMax[d];
        }

        meshes.push({
          elementId: el.id,
          verts: worldVerts,
          indices: localGeom.indices,
          color: localGeom.color,
          centroid,
          bbox: el.bbox
        });
      } else {
        el.centroid = el.pos.slice();
        el.bbox = {
          min: [el.pos[0] - 0.25, el.pos[1] - 0.25, el.pos[2] - 0.25],
          max: [el.pos[0] + 0.25, el.pos[1] + 0.25, el.pos[2] + 0.25]
        };
      }
    }

    const center = globalMin[0] !== Infinity
      ? [(globalMin[0] + globalMax[0]) * 0.5, (globalMin[1] + globalMax[1]) * 0.5, (globalMin[2] + globalMax[2]) * 0.5]
      : [0, 0, 0];

    return {
      meshes,
      bounds: { min: globalMin, max: globalMax, center }
    };
  }

  // ── IN-MEMORY ATOMIC STEP WRITER (Zero-Server IFC Modification) ──────────
  function appendEntitiesBeforeEndsec(rawText, newLines) {
    if (!newLines || newLines.length === 0) return rawText;
    const block = '\n' + newLines.join('\n') + '\n';
    const lastEndsec = rawText.lastIndexOf('ENDSEC;');
    if (lastEndsec !== -1) {
      return rawText.slice(0, lastEndsec) + block + rawText.slice(lastEndsec);
    }
    return rawText + block;
  }

  // 1. Inject IfcSystem + IfcRelAssignsToGroup (for Sets, 4D Plan Sets, 5D Cost Sets)
  function injectIfcSystems(model, groupsMap, prefix = 'SET') {
    let nextId = model.maxStepId + 1;
    const oh = model.defaultOwnerHistoryId ? `#${model.defaultOwnerHistoryId}` : '$';
    const newLines = [];
    let createdCount = 0;

    for (const groupKey in groupsMap) {
      const memberEls = groupsMap[groupKey];
      if (!memberEls || memberEls.length === 0) continue;
      const sysName = prefix ? `${prefix}_${groupKey}` : String(groupKey);
      const sysId = nextId++;
      const relId = nextId++;
      const refs = memberEls.map(e => `#${e.id}`).join(',');

      newLines.push(`#${sysId}=IFCSYSTEM('${generateIfcGuid()}',${oh},'${encodeStep(sysName)}','Generado por Fractal IFC Suite (AsuntoBIM)',$);`);
      newLines.push(`#${relId}=IFCRELASSIGNSTOGROUP('${generateIfcGuid()}',${oh},'${encodeStep(sysName)}',$,(${refs}),.PRODUCT.,#${sysId});`);
      createdCount++;
    }

    const updatedText = appendEntitiesBeforeEndsec(model.rawText, newLines);
    const updatedModel = parseIfcStep(updatedText, model.filename, updatedText.length);
    return { model: updatedModel, createdCount, addedEntities: newLines.length };
  }

  // 2. Inject IfcClassification + IfcClassificationReference + IfcRelAssociatesClassification
  function injectClassifications(model, systemName = 'SCFClass_Funciones') {
    let nextId = model.maxStepId + 1;
    const oh = model.defaultOwnerHistoryId ? `#${model.defaultOwnerHistoryId}` : '$';
    const newLines = [];

    // Find or create IFCCLASSIFICATION
    let classId = null;
    for (const cid in model.classifications) {
      if (model.classifications[cid].name === systemName || !classId) {
        classId = parseInt(cid, 10);
      }
    }
    if (!classId) {
      classId = nextId++;
      newLines.push(`#${classId}=IFCCLASSIFICATION('Railway Innovation Hub','V02 2022','2022-12-30','${encodeStep(systemName)}',$,'https://www.railwayinnovationhub.com/bim/',$);`);
    }

    // Group elements by ADIF_00_Codigo_Producto (or fallback class)
    const byCode = {};
    let classifiedElements = 0;
    for (const el of model.elements) {
      const code = el.flatProps['ADIF_00_Codigo_Producto'] || (el.classifications[0] && el.classifications[0].code) || 'FUN.GEN.010.010';
      const desc = el.flatProps['ADIF_00_Descripcion_Producto'] || (el.classifications[0] && el.classifications[0].name) || el.type;
      const key = `${code}|||${desc}`;
      if (!byCode[key]) byCode[key] = { code, desc, ids: [] };
      byCode[key].ids.push(el.id);
      classifiedElements++;
    }

    for (const key in byCode) {
      const item = byCode[key];
      const refId = nextId++;
      const relId = nextId++;
      const idList = item.ids.map(id => `#${id}`).join(',');
      newLines.push(`#${refId}=IFCCLASSIFICATIONREFERENCE('https://www.railwayinnovationhub.com/bim/','${encodeStep(item.code)}','${encodeStep(item.desc)}',#${classId},$,$);`);
      newLines.push(`#${relId}=IFCRELASSOCIATESCLASSIFICATION('${generateIfcGuid()}',${oh},'${encodeStep(item.desc)}','${encodeStep(item.desc)}:${encodeStep(item.code)}',(${idList}),#${refId});`);
    }

    const updatedText = appendEntitiesBeforeEndsec(model.rawText, newLines);
    const updatedModel = parseIfcStep(updatedText, model.filename, updatedText.length);
    return { model: updatedModel, classifiedElements, groupsCount: Object.keys(byCode).length };
  }

  // 3. Apply Name_Type_ID standardization (Name = BaseName_ADIF_00_Id_Objeto)
  function applyNameTypeId(model) {
    const renameMap = {};
    let updatedCount = 0;
    for (const el of model.elements) {
      const objId = el.flatProps['ADIF_00_Id_Objeto'] || el.tag || String(el.id);
      const suffix = `_${objId}`;
      const baseName = el.name.endsWith(suffix) ? el.name.slice(0, -suffix.length) : el.name;
      const targetName = `${baseName}${suffix}`;
      if (el.name !== targetName) {
        renameMap[el.id] = targetName;
        updatedCount++;
      }
    }
    if (updatedCount === 0) return { model, updatedCount: 0 };

    const lines = model.rawText.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^#(\d+)=([A-Z0-9_]+)\((.*)\);$/);
      if (m) {
        const id = parseInt(m[1], 10);
        if (renameMap[id]) {
          const args = splitStepArgs(m[3]);
          if (args.length >= 3) {
            args[2] = `'${encodeStep(renameMap[id])}'`;
            lines[i] = `#${id}=${m[2]}(${args.join(',')});`;
          }
        }
      }
    }
    const updatedText = lines.join('\n');
    return { model: parseIfcStep(updatedText, model.filename, updatedText.length), updatedCount };
  }

  // 4. Rename IfcMaterial & optionally sync material name to Pset (MAT_Prop)
  function updateMaterialsInStep(model, materialRenames, syncPsetName = 'Pset_MaterialSync', syncPropName = 'MAT_Prop') {
    let lines = model.rawText.split(/\r?\n/);
    let renamedCount = 0;

    if (materialRenames && Object.keys(materialRenames).length > 0) {
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^#(\d+)=IFCMATERIAL\((.*)\);$/i);
        if (m) {
          const id = parseInt(m[1], 10);
          if (materialRenames[id]) {
            const args = splitStepArgs(m[2]);
            args[0] = `'${encodeStep(materialRenames[id])}'`;
            lines[i] = `#${id}=IFCMATERIAL(${args.join(',')});`;
            renamedCount++;
          }
        }
      }
    }

    let rawText = lines.join('\n');
    let tempModel = parseIfcStep(rawText, model.filename, rawText.length);

    if (syncPsetName && syncPropName) {
      let nextId = tempModel.maxStepId + 1;
      const oh = tempModel.defaultOwnerHistoryId ? `#${tempModel.defaultOwnerHistoryId}` : '$';
      const byMat = {};
      for (const el of tempModel.elements) {
        const mName = el.material || 'Sin Material';
        if (!byMat[mName]) byMat[mName] = [];
        byMat[mName].push(el.id);
      }
      const newLines = [];
      for (const mName in byMat) {
        const propId = nextId++;
        const psetId = nextId++;
        const relId = nextId++;
        const idList = byMat[mName].map(id => `#${id}`).join(',');
        newLines.push(`#${propId}=IFCPROPERTYSINGLEVALUE('${encodeStep(syncPropName)}',$,IFCTEXT('${encodeStep(mName)}'),$);`);
        newLines.push(`#${psetId}=IFCPROPERTYSET('${generateIfcGuid()}',${oh},'${encodeStep(syncPsetName)}',$,(#${propId}));`);
        newLines.push(`#${relId}=IFCRELDEFINESBYPROPERTIES('${generateIfcGuid()}',${oh},$,$,(${idList}),#${psetId});`);
      }
      rawText = appendEntitiesBeforeEndsec(rawText, newLines);
      tempModel = parseIfcStep(rawText, model.filename, rawText.length);
    }

    return { model: tempModel, renamedCount };
  }

  // 5. Bulk Replace or Inject Property Values in STEP
  function bulkUpdateProperty(model, propName, newValue, filterFn = null, targetPsetName = 'ADIF_00_Generales') {
    const matchedEls = model.elements.filter(el => !filterFn || filterFn(el));
    if (matchedEls.length === 0) return { model, updatedElements: 0 };

    const propIdsToEdit = new Set();
    const elsMissingProp = [];

    for (const el of matchedEls) {
      let foundStepId = null;
      for (const psName in el.propStepIds) {
        if (el.propStepIds[psName] && el.propStepIds[psName][propName]) {
          foundStepId = el.propStepIds[psName][propName];
          break;
        }
      }
      if (foundStepId) {
        propIdsToEdit.add(foundStepId);
      } else {
        elsMissingProp.push(el.id);
      }
    }

    const lines = model.rawText.split(/\r?\n/);
    if (propIdsToEdit.size > 0) {
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^#(\d+)=IFCPROPERTYSINGLEVALUE\((.*)\);$/i);
        if (m) {
          const id = parseInt(m[1], 10);
          if (propIdsToEdit.has(id)) {
            const args = splitStepArgs(m[2]);
            if (args.length >= 3) {
              args[2] = `IFCTEXT('${encodeStep(newValue)}')`;
              lines[i] = `#${id}=IFCPROPERTYSINGLEVALUE(${args.join(',')});`;
            }
          }
        }
      }
    }

    let rawText = lines.join('\n');
    if (elsMissingProp.length > 0) {
      let nextId = model.maxStepId + 1;
      const oh = model.defaultOwnerHistoryId ? `#${model.defaultOwnerHistoryId}` : '$';
      const propId = nextId++;
      const psetId = nextId++;
      const relId = nextId++;
      const idList = elsMissingProp.map(id => `#${id}`).join(',');
      const newLines = [
        `#${propId}=IFCPROPERTYSINGLEVALUE('${encodeStep(propName)}',$,IFCTEXT('${encodeStep(newValue)}'),$);`,
        `#${psetId}=IFCPROPERTYSET('${generateIfcGuid()}',${oh},'${encodeStep(targetPsetName)}',$,(#${propId}));`,
        `#${relId}=IFCRELDEFINESBYPROPERTIES('${generateIfcGuid()}',${oh},$,$,(${idList}),#${psetId});`
      ];
      rawText = appendEntitiesBeforeEndsec(rawText, newLines);
    }

    const updatedModel = parseIfcStep(rawText, model.filename, rawText.length);
    return { model: updatedModel, updatedElements: matchedEls.length };
  }

  // 6. Inject Project Defaults onto IFCPROJECT (#32 / #22)
  function injectProjectDefaults(model, defaultsObj) {
    const projId = model.projectNodeId;
    if (!projId) return { model, updatedCount: 0 };
    let nextId = model.maxStepId + 1;
    const oh = model.defaultOwnerHistoryId ? `#${model.defaultOwnerHistoryId}` : '$';
    const newLines = [];
    const propIds = [];

    for (const k in defaultsObj) {
      const val = defaultsObj[k];
      if (val === undefined || val === null) continue;
      const pid = nextId++;
      propIds.push(`#${pid}`);
      newLines.push(`#${pid}=IFCPROPERTYSINGLEVALUE('${encodeStep(k)}',$,IFCTEXT('${encodeStep(val)}'),$);`);
    }

    if (propIds.length > 0) {
      const psetId = nextId++;
      const relId = nextId++;
      newLines.push(`#${psetId}=IFCPROPERTYSET('${generateIfcGuid()}',${oh},'ADIF_02_Localizacion',$,(${propIds.join(',')}));`);
      newLines.push(`#${relId}=IFCRELDEFINESBYPROPERTIES('${generateIfcGuid()}',${oh},$,$,(#${projId}),#${psetId});`);
    }

    const updatedText = appendEntitiesBeforeEndsec(model.rawText, newLines);
    return { model: parseIfcStep(updatedText, model.filename, updatedText.length), updatedCount: propIds.length };
  }

  // 7. Update STEP Header (FILE_NAME)
  function updateStepHeader(model, updates) {
    const author = encodeStep(updates.author || model.header.author || 'Equipo BIM');
    const org = encodeStep(updates.organization || model.header.organization || 'Asunto BIM');
    const sys = encodeStep(updates.originatingSystem || model.header.originatingSystem || 'Fractal IFC Suite');
    const ts = encodeStep(updates.timestamp || new Date().toISOString().slice(0, 19));
    const fname = encodeStep(updates.filename || model.filename);

    const newFileNameLine = `FILE_NAME('${fname}','${ts}',('${author}'),('${org}'),'${sys}','${sys}','');`;
    const updatedText = model.rawText.replace(/FILE_NAME\s*\([\s\S]*?\)\s*;/i, newFileNameLine);
    return parseIfcStep(updatedText, updates.filename || model.filename, updatedText.length);
  }

  // ── NAVISWORKS SELECTION SETS XML GENERATOR ───────────────────────────────
  function buildNavisworksSelectionSetsXml(groupsMap, propCategory = 'ADIF_00_Generales', propName = 'ADIF_00_Codigo_Producto') {
    let xml = `<?xml version="1.0" encoding="UTF-8" ?>\n<exchange xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" units="m">\n  <selectionsets>\n    <viewfolder name="Fractal_IFC_${propName}">\n`;
    for (const val in groupsMap) {
      const safeVal = String(val).replace(/["<>&]/g, '');
      xml += `      <selectionset name="${safeVal}">\n        <findspec mode="all" disjoint="0">\n          <conditions>\n            <condition test="equals" flags="10">\n              <category><name internal="${propCategory}">${propCategory}</name></category>\n              <property><name internal="${propName}">${propName}</name></property>\n              <value><data type="wstring">${safeVal}</data></value>\n            </condition>\n          </conditions>\n        </findspec>\n      </selectionset>\n`;
    }
    xml += `    </viewfolder>\n  </selectionsets>\n</exchange>`;
    return xml;
  }

  // ── CIVIL 3D JSON EXPORT GENERATORS (c3d-export-setup) ────────────────────
  function buildC3dExportConfigJsons(model) {
    const configJson = {
      "$schema": "https://autodesk.com/civil3d/ifcinfraconfiguration/2025/schema.json",
      "SchemaVersion": "IFC4X3_ADD2",
      "ProjectInformation": {
        "Expediente": model ? (model.projectDefaults['ADIF_02_Expediente_Actuacion'] || 'EXP-0000000000') : 'EXP-0000000000',
        "CodigoActuacion": model ? (model.projectDefaults['ADIF_02_Codigo_Actuacion'] || 'ACT-001') : 'ACT-001',
        "NombreGlobal": model ? (model.projectDefaults['ADIF_02_Nombre_Global'] || 'Proyecto Infraestructura BIM') : 'Proyecto Infraestructura BIM',
        "CoordinateReferenceSystem": "EPSG:25830",
        "CRSDescription": "ETRS89 / UTM zone 30N"
      },
      "ExportOptions": {
        "ExportAlignments": true,
        "ExportCorridors": true,
        "ExportPipeNetworks": true,
        "ExportSurfaces": false,
        "UseTriangulatedFaceSet": true,
        "ExportLinearPlacement": true,
        "ExportPropertySets": true
      }
    };

    const mappingJson = {
      "Version": "13.7.235.0",
      "Mappings": [
        { "Civil3DCategory": "Structure", "Subcategory": "Arquetas", "IfcEntity": "IfcDistributionChamberElement", "PredefinedType": "INSPECTIONCHAMBER", "SCFClass": "FUN.DRE.020.020" },
        { "Civil3DCategory": "Pipe", "Subcategory": "Colectores", "IfcEntity": "IfcPipeSegment", "PredefinedType": "CULVERT", "SCFClass": "FUN.DRE.030.120" },
        { "Civil3DCategory": "CorridorSolid", "Subcategory": "Cuneta", "IfcEntity": "IfcBuiltElement", "PredefinedType": "USERDEFINED", "SCFClass": "FUN.DRE.010.010" },
        { "Civil3DCategory": "Alignment", "Subcategory": "Eje Ferrocarril", "IfcEntity": "IfcAlignment", "PredefinedType": "USERDEFINED", "SCFClass": "FUN.VIA.010.010" },
        { "Civil3DCategory": "CogoPoint", "Subcategory": "Punto Replanteo", "IfcEntity": "IfcBuiltElement", "PredefinedType": "NOTDEFINED", "SCFClass": "FUN.ENT.010.010" }
      ]
    };

    const propMappingJson = {
      "Version": "2.0",
      "PropertySets": {
        "ADIF_00_Generales": ["ADIF_00_Codigo_Archivo", "ADIF_00_Disciplina", "ADIF_00_Subdisciplina", "ADIF_00_Codigo_Producto", "ADIF_00_Descripcion_Producto", "ADIF_00_Id_Objeto"],
        "ADIF_01_Dimensiones": ["ADIF_01_Longitud", "ADIF_01_Superficie", "ADIF_01_Volumen", "ADIF_01_Seccion", "ADIF_01_Pendiente"],
        "ADIF_02_Localizacion": ["ADIF_02_Zonificacion", "ADIF_02_Km_Inicio", "ADIF_02_Km_Fin", "ADIF_02_Via", "ADIF_02_Sistema_Coordenadas"],
        "ADIF_03_Coordinacion3D": ["ADIF_03_Codigo_Estado", "ADIF_03_Descripcion_Estado", "ADIF_03_Fuente_Definicion", "ADIF_03_Visibilidad_Temporal", "ADIF_03_Codigo_Estudio"],
        "ADIF_04_4D": ["ADIF_04_Codigo_Actividad", "ADIF_04_Fase", "ADIF_04_Inicio_Actividad"],
        "ADIF_05_5D": ["ADIF_05_Codigo_Partida"],
        "INGR": ["INGR_Descripcion_Actividad", "INGR_Inicio_Planeado", "INGR_Fin_Planeado", "INGR_Importe_Total", "INGR_Mes_Actual"]
      }
    };

    return { configJson, mappingJson, propMappingJson };
  }

  // ── SYNTHETIC PLACEHOLDER GENERATOR (No private models embedded) ──────────
  function getDemoModels() {
    const rvtDemo = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition[DesignTransferView]'),'2;1');
FILE_NAME('000000000001-GEN-BIM-ZZ-EST-000100-001_MOD_EJEMPLO_RVT.ifc','2026-01-01T10:00:00',('Julian Mejia'),('Asunto BIM'),'EXPRESS','Autodesk Revit 2025 (ESP)','');
FILE_SCHEMA(('IFC4X3_ADD2'));
ENDSEC;
DATA;
#1=IFCORGANIZATION($,'Autodesk Revit 2025 (ESP)',$,$,$);
#2=IFCAPPLICATION(#1,'2025','Autodesk Revit 2025 (ESP)','Revit');
#3=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCDIRECTION((1.,0.,0.));
#6=IFCDIRECTION((-1.,0.,0.));
#9=IFCDIRECTION((0.,0.,1.));
#11=IFCDIRECTION((1.,0.));
#15=IFCPERSON($,'Mejia','Julian',$,$,$,$,$);
#16=IFCORGANIZATION($,'Asunto BIM','',$,$);
#17=IFCPERSONANDORGANIZATION(#15,#16,$);
#18=IFCOWNERHISTORY(#17,#2,$,.NOCHANGE.,$,$,$,1790000000);
#19=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#22=IFCAXIS2PLACEMENT3D(#3,$,$);
#24=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-05,#22,$);
#26=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#24,$,.MODEL_VIEW.,$);
#30=IFCPROJECTEDCRS('EPSG:25830','ETRS89 / UTM zone 30N','ETRF89',$,$,$,#19);
#31=IFCMAPCONVERSION(#24,#30,0.,0.,0.,1.,0.,$);
#32=IFCPROJECT('0qYoHyf4H6z9hukM_BApqD',#18,'EXP-0000000001',$,$,'Proyecto Ejemplo OpenBIM',$,(#24),#19);
#50=IFCAXIS2PLACEMENT3D(#3,$,$);
#93=IFCCARTESIANPOINT((440000.0,4470000.0,600.0));
#95=IFCAXIS2PLACEMENT3D(#93,#9,#5);
#96=IFCLOCALPLACEMENT($,#95);
#97=IFCSITE('0qYoHyf4H6z9hukM_BApqF',#18,'Emplazamiento General',$,$,#96,$,$,.ELEMENT.,$,$,0.,$,$);
#51=IFCLOCALPLACEMENT(#96,#50);
#52=IFCRAILWAY('0qYoHyf4H6z9hukM_BApqC',#18,'Tramo Ferroviario Ejemplo',$,$,#51,$,'Tramo Ferroviario Ejemplo',.ELEMENT.,$);
#68=IFCRAILWAYPART('3HZdnvfOv5Kgnu19YsmDAd',#18,'Nivel_00',$,'Nivel',#51,$,'Nivel_00',.ELEMENT.,$,$);
#100=IFCRELAGGREGATES('1aggProjSite0000000001',#18,$,$,#32,(#97));
#101=IFCRELAGGREGATES('1aggSiteRail0000000002',#18,$,$,#97,(#52));
#102=IFCRELAGGREGATES('1aggRailPart0000000003',#18,$,$,#52,(#68));
#1168=IFCAXIS2PLACEMENT2D(#3,#11);
#1169=IFCCIRCLEPROFILEDEF(.AREA.,'Tubo_Ejemplo',#1168,0.20);
#1172=IFCAXIS2PLACEMENT3D(#3,#5,#6);
#1173=IFCEXTRUDEDAREASOLID(#1169,#1172,#9,5.0);
#1182=IFCSHAPEREPRESENTATION(#26,'Body','SweptSolid',(#1173));
#1184=IFCPRODUCTDEFINITIONSHAPE($,$,(#1182));
#1190=IFCPIPESEGMENT('1Q9FYHRcjBYAeYTjbs0ekA',#18,'Elemento_Demo_01','N/A','Tubo',#51,#1184,'1001',.CULVERT.);
#140512=IFCRELCONTAINEDINSPATIALSTRUCTURE('16xO$9ugfBigYWeYi0q1ie',#18,$,$,(#1190),#68);
ENDSEC;
END-ISO-10303-21;`;

    return {
      rvt: { filename: '000000000001-GEN-BIM-ZZ-EST-000100-001_MOD_EJEMPLO_RVT.ifc', text: rvtDemo },
      c3d: { filename: '000000000001-GEN-BIM-ZZ-OBC-000101-001_MOD_EJEMPLO_C3D.ifc', text: rvtDemo }
    };
  }

  return {
    PHYSICAL_IFC_TYPES,
    SPATIAL_CONTAINER_TYPES,
    MANDATORY_ADIF_PARAMS,
    decodeStep,
    encodeStep,
    generateIfcGuid,
    splitStepArgs,
    cleanStepToken,
    isMandatoryEmpty,
    parseIfcStep,
    extractModel3DGeometry,
    injectIfcSystems,
    injectClassifications,
    applyNameTypeId,
    updateMaterialsInStep,
    bulkUpdateProperty,
    injectProjectDefaults,
    updateStepHeader,
    buildNavisworksSelectionSetsXml,
    buildC3dExportConfigJsons,
    getDemoModels
  };
});
