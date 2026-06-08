const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const archiver = require('archiver');
const cors = require('cors');
const AdmZip = require('adm-zip');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20*1024*1024, files: 500, fields: 1000 } });
const single = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50*1024*1024 } });

function hexToRgba(hex) {
    const c = (hex||'#ffffff').replace('#','').padEnd(6,'0');
    return { r:parseInt(c.slice(0,2),16)||255, g:parseInt(c.slice(2,4),16)||255, b:parseInt(c.slice(4,6),16)||255, alpha:1 };
}
const progressClients = new Map();
app.get('/progress/:jobId', (req, res) => {
    res.setHeader('Content-Type','text/event-stream');
    res.setHeader('Cache-Control','no-cache');
    res.setHeader('Connection','keep-alive');
    res.flushHeaders();
    progressClients.set(req.params.jobId, res);
    req.on('close', () => progressClients.delete(req.params.jobId));
});
function sendProgress(jobId, data) {
    const c = progressClients.get(jobId);
    if (c) c.write(`data: ${JSON.stringify(data)}\n\n`);
}
function resizePos(alignment) {
    const smart = ['entropy','attention'];
    if (smart.includes(alignment)) return alignment;
    return ({center:'center',north:'top',south:'bottom',west:'left',east:'right'}[alignment]||'center');
}
function buildTextSvg(text, fontSize, color, position, W, H) {
    if (!text) return null;
    const pad=20, safe=text.replace(/[<>&"]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
    const anchors={'top-left':{x:pad,y:pad+fontSize,a:'start'},'top-right':{x:W-pad,y:pad+fontSize,a:'end'},'bottom-left':{x:pad,y:H-pad,a:'start'},'bottom-right':{x:W-pad,y:H-pad,a:'end'},'center':{x:W/2,y:H/2,a:'middle'}};
    const p=anchors[position]||anchors['bottom-right'];
    return Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><text x="${p.x}" y="${p.y}" font-family="sans-serif" font-size="${fontSize}" fill="${color}" text-anchor="${p.a}" paint-order="stroke" stroke="#00000088" stroke-width="3">${safe}</text></svg>`);
}
function zipResponse(res, filename) {
    res.setHeader('Content-Type','application/zip');
    res.setHeader('Content-Disposition',`attachment; filename="${filename}"`);
    const archive = archiver('zip',{zlib:{level:6}});
    archive.pipe(res);
    return archive;
}

// ── TOOL 1: Bulk Resizer ──
const processPipeline = async (req, res, isTemplate) => {
    try {
        const jobId=req.body.jobId||'job', targetWidth=parseInt(req.body.targetWidth||req.body.width||1080), targetHeight=parseInt(req.body.targetHeight||req.body.height||1080);
        const format=req.body.format||'webp', quality=Math.min(100,Math.max(1,parseInt(req.body.quality||90)));
        const fitMode=req.body.fitMode||'contain', alignment=req.body.alignment||'center';
        const flip=req.body.flip==='true', sharpenOn=req.body.sharpen==='true', multiRes=req.body.multiRes==='true', generateCSV=req.body.csv==='true';
        const bgColor=hexToRgba(req.body.bgColor);
        const brightness=parseFloat(req.body.brightness||1), saturation=parseFloat(req.body.saturation||1), hue=parseInt(req.body.hue||0);
        const needsColor=brightness!==1||saturation!==1||hue!==0;
        const overlayText=(req.body.overlayText||'').trim(), overlaySize=parseInt(req.body.overlaySize||32), overlayColor=req.body.overlayColor||'#ffffff', overlayPos=req.body.overlayPos||'bottom-right';
        let renameMap={}; try{renameMap=JSON.parse(req.body.renameMap||'{}');}catch(e){}
        const watermarkFile=req.files['watermark']?req.files['watermark'][0]:null;
        const images=req.files['images']||[], rawPaths=req.body.paths||[], paths=Array.isArray(rawPaths)?rawPaths:[rawPaths];
        if(!images.length) return res.status(400).json({error:'No images received.'});
        const resolutions=multiRes?[{suffix:'_large',w:2000,h:2000},{suffix:'_base',w:targetWidth,h:targetHeight},{suffix:'_thumb',w:500,h:500}]:[{suffix:'',w:targetWidth,h:targetHeight}];
        let doneSteps=0,totalOutputBytes=0;
        const archive=zipResponse(res,'processed_images.zip');
        const csvRows=['SKU,Image_Role,File_Path'];
        for(let i=0;i<images.length;i++){
            const file=images[i], relativePath=paths[i]||file.originalname, origName=path.parse(file.originalname).name;
            const cleanName=renameMap[file.originalname]||renameMap[origName]||origName, ext=format==='jpeg'?'jpg':format, dirPath=path.dirname(relativePath);
            sendProgress(jobId,{current:i+1,total:images.length,filename:file.originalname,percent:Math.round((i/images.length)*100)});
            for(const resData of resolutions){
                const outName=path.join(dirPath,`${cleanName}${resData.suffix}.${ext}`);
                let pipeline;
                if(isTemplate){
                    const scale=parseFloat(req.body.scale)||1,offsetX=parseFloat(req.body.offsetX)||0,offsetY=parseFloat(req.body.offsetY)||0,mult=resData.w/500;
                    const meta=await sharp(file.buffer).metadata(), fw=Math.max(1,Math.round(meta.width*scale*mult));
                    let rb=sharp(file.buffer).withMetadata().resize({width:fw}); if(flip) rb=rb.flop();
                    const rbuf=await rb.toBuffer();
                    pipeline=sharp({create:{width:resData.w,height:resData.h,channels:4,background:bgColor}}).composite([{input:rbuf,left:Math.max(0,Math.round(offsetX*mult)),top:Math.max(0,Math.round(offsetY*mult))}]);
                } else {
                    pipeline=sharp(file.buffer).withMetadata().resize({width:resData.w,height:resData.h,fit:fitMode,position:resizePos(alignment),background:bgColor});
                    if(flip) pipeline=pipeline.flop();
                }
                if(needsColor) pipeline=pipeline.modulate({brightness,saturation,hue});
                if(sharpenOn) pipeline=pipeline.sharpen({sigma:1,m1:1.5,m2:0.5});
                if(watermarkFile){const pbuf=await pipeline.toFormat(format).toBuffer(),wmr=await sharp(watermarkFile.buffer).resize({width:Math.max(50,Math.round(resData.w*0.15))}).toBuffer();pipeline=sharp(pbuf).composite([{input:wmr,gravity:'southeast'}]);}
                if(overlayText){const pbuf=await pipeline.toFormat(format).toBuffer(),svgBuf=buildTextSvg(overlayText,overlaySize,overlayColor,overlayPos,resData.w,resData.h);pipeline=sharp(pbuf).composite([{input:svgBuf}]);}
                const fmtOpts=format==='png'?{compressionLevel:Math.min(9,Math.round((100-quality)/11))}:{quality};
                const outBuf=await pipeline.toFormat(format,fmtOpts).toBuffer();
                totalOutputBytes+=outBuf.length; archive.append(outBuf,{name:outName});
                if(generateCSV){const role=resData.suffix==='_thumb'?'thumbnail':resData.suffix==='_large'?'high_res':'base_image';csvRows.push(`${dirPath},${role},${outName}`);}
                doneSteps++;
            }
        }
        if(generateCSV) archive.append(csvRows.join('\n'),{name:'magento_import.csv'});
        sendProgress(jobId,{done:true,total:images.length,totalFiles:doneSteps,sizeKB:Math.round(totalOutputBytes/1024),format:format.toUpperCase(),quality});
        await archive.finalize();
    } catch(err){console.error('[Resizer]',err.message);if(!res.headersSent) res.status(500).json({error:err.message});}
};
app.post('/process-auto', upload.fields([{name:'images',maxCount:500},{name:'watermark',maxCount:1}]),(req,res)=>processPipeline(req,res,false));
app.post('/process-template', upload.fields([{name:'images',maxCount:500},{name:'watermark',maxCount:1}]),(req,res)=>processPipeline(req,res,true));

// ── TOOL 2: Compressor ──
app.post('/compress', upload.fields([{name:'images',maxCount:500}]), async (req,res) => {
    try {
        const jobId=req.body.jobId||'c', quality=Math.min(95,Math.max(10,parseInt(req.body.quality||80))), format=req.body.format||'same';
        const images=req.files['images']||[];
        if(!images.length) return res.status(400).json({error:'No images.'});
        const archive=zipResponse(res,'compressed_images.zip');
        let totalIn=0,totalOut=0;
        for(let i=0;i<images.length;i++){
            const file=images[i]; totalIn+=file.buffer.length;
            sendProgress(jobId,{current:i+1,total:images.length,filename:file.originalname,percent:Math.round((i/images.length)*100)});
            const meta=await sharp(file.buffer).metadata();
            const fmt=format==='same'?(meta.format==='jpeg'?'jpeg':meta.format||'webp'):format;
            const ext=fmt==='jpeg'?'jpg':fmt, outName=path.parse(file.originalname).name+'.'+ext;
            const fmtOpts=fmt==='png'?{compressionLevel:Math.min(9,Math.round((100-quality)/11))}:{quality};
            const outBuf=await sharp(file.buffer).toFormat(fmt,fmtOpts).toBuffer();
            totalOut+=outBuf.length; archive.append(outBuf,{name:outName});
        }
        sendProgress(jobId,{done:true,total:images.length,sizeIn:Math.round(totalIn/1024),sizeOut:Math.round(totalOut/1024),saved:Math.round((1-totalOut/totalIn)*100)});
        await archive.finalize();
    } catch(err){console.error('[Compress]',err.message);if(!res.headersSent) res.status(500).json({error:err.message});}
});

// ── TOOL 3: Converter ──
app.post('/convert', upload.fields([{name:'images',maxCount:500}]), async (req,res) => {
    try {
        const jobId=req.body.jobId||'cv', toFormat=req.body.toFormat||'webp', quality=parseInt(req.body.quality||90);
        const images=req.files['images']||[];
        if(!images.length) return res.status(400).json({error:'No images.'});
        const archive=zipResponse(res,`converted_${toFormat}.zip`);
        for(let i=0;i<images.length;i++){
            const file=images[i];
            sendProgress(jobId,{current:i+1,total:images.length,filename:file.originalname,percent:Math.round((i/images.length)*100)});
            const ext=toFormat==='jpeg'?'jpg':toFormat, outName=path.parse(file.originalname).name+'.'+ext;
            const fmtOpts=toFormat==='png'?{compressionLevel:6}:{quality};
            const outBuf=await sharp(file.buffer).toFormat(toFormat,fmtOpts).toBuffer();
            archive.append(outBuf,{name:outName});
        }
        sendProgress(jobId,{done:true,total:images.length,format:toFormat.toUpperCase()});
        await archive.finalize();
    } catch(err){console.error('[Convert]',err.message);if(!res.headersSent) res.status(500).json({error:err.message});}
});

// ── TOOL 4: Cropper ──
app.post('/crop', upload.fields([{name:'images',maxCount:500}]), async (req,res) => {
    try {
        const jobId=req.body.jobId||'cr', cropW=parseInt(req.body.cropW||1080), cropH=parseInt(req.body.cropH||1080);
        const gravity=req.body.gravity||'center', format=req.body.format||'webp', quality=parseInt(req.body.quality||90);
        const images=req.files['images']||[];
        if(!images.length) return res.status(400).json({error:'No images.'});
        const archive=zipResponse(res,'cropped_images.zip');
        for(let i=0;i<images.length;i++){
            const file=images[i];
            sendProgress(jobId,{current:i+1,total:images.length,filename:file.originalname,percent:Math.round((i/images.length)*100)});
            const ext=format==='jpeg'?'jpg':format, outName=path.parse(file.originalname).name+'_crop.'+ext;
            const outBuf=await sharp(file.buffer).resize({width:cropW,height:cropH,fit:'cover',position:resizePos(gravity)}).toFormat(format,{quality}).toBuffer();
            archive.append(outBuf,{name:outName});
        }
        sendProgress(jobId,{done:true,total:images.length});
        await archive.finalize();
    } catch(err){console.error('[Crop]',err.message);if(!res.headersSent) res.status(500).json({error:err.message});}
});

// ── TOOL 5: Watermarker ──
app.post('/watermark', upload.fields([{name:'images',maxCount:500},{name:'watermark',maxCount:1}]), async (req,res) => {
    try {
        const jobId=req.body.jobId||'wm', position=req.body.position||'southeast';
        const wmScale=Math.min(0.5,Math.max(0.05,parseFloat(req.body.scale||0.2))), format=req.body.format||'same', quality=parseInt(req.body.quality||90);
        const textMode=req.body.textMode==='true', wmText=(req.body.wmText||'').trim(), wmColor=req.body.wmColor||'#ffffff', wmSize=parseInt(req.body.wmSize||48);
        const images=req.files['images']||[], wmFile=req.files['watermark']?req.files['watermark'][0]:null;
        if(!images.length) return res.status(400).json({error:'No images.'});
        if(!textMode&&!wmFile) return res.status(400).json({error:'Upload watermark image or enable text mode.'});
        const posMap={southeast:'bottom-right',southwest:'bottom-left',northeast:'top-right',northwest:'top-left',center:'center'};
        const archive=zipResponse(res,'watermarked_images.zip');
        for(let i=0;i<images.length;i++){
            const file=images[i];
            sendProgress(jobId,{current:i+1,total:images.length,filename:file.originalname,percent:Math.round((i/images.length)*100)});
            const meta=await sharp(file.buffer).metadata();
            const outFmt=format==='same'?(meta.format==='jpeg'?'jpeg':meta.format||'webp'):format;
            const ext=outFmt==='jpeg'?'jpg':outFmt, outName=path.parse(file.originalname).name+'_wm.'+ext;
            const fmtOpts=outFmt==='png'?{compressionLevel:6}:{quality};
            let composite;
            if(textMode&&wmText){
                const svgBuf=buildTextSvg(wmText,wmSize,wmColor,posMap[position]||'bottom-right',meta.width,meta.height);
                composite=[{input:svgBuf,blend:'over'}];
            } else {
                const wmW=Math.round((meta.width||1000)*wmScale);
                const wmBuf=await sharp(wmFile.buffer).resize({width:Math.max(10,wmW)}).toBuffer();
                composite=[{input:wmBuf,gravity:position,blend:'over'}];
            }
            const outBuf=await sharp(file.buffer).composite(composite).toFormat(outFmt,fmtOpts).toBuffer();
            archive.append(outBuf,{name:outName});
        }
        sendProgress(jobId,{done:true,total:images.length});
        await archive.finalize();
    } catch(err){console.error('[Watermark]',err.message);if(!res.headersSent) res.status(500).json({error:err.message});}
});

// ── TOOL 6: Palette Extractor ──
app.post('/palette', single.single('image'), async (req,res) => {
    try {
        if(!req.file) return res.status(400).json({error:'No image uploaded.'});
        const count=Math.min(16,Math.max(3,parseInt(req.body.count||8)));
        const {data}=await sharp(req.file.buffer).resize(120,120,{fit:'cover'}).removeAlpha().raw().toBuffer({resolveWithObject:true});
        function toHex(r,g,b){return '#'+[r,g,b].map(v=>v.toString(16).padStart(2,'0')).join('');}
        function dist(a,b){return Math.sqrt((a[0]-b[0])**2+(a[1]-b[1])**2+(a[2]-b[2])**2);}
        const pixels=[]; for(let i=0;i<data.length;i+=3) pixels.push([data[i],data[i+1],data[i+2]]);
        const step=Math.max(1,Math.floor(pixels.length/800));
        const palette=[];
        for(const px of pixels.filter((_,i)=>i%step===0)){
            if(!palette.length){palette.push(px);continue;}
            if(Math.min(...palette.map(p=>dist(px,p)))>25) palette.push(px);
            if(palette.length>=count*4) break;
        }
        const final=palette.slice(0,count).map(([r,g,b])=>({hex:toHex(r,g,b),r,g,b,textColor:(r*299+g*587+b*114)/1000>128?'#000000':'#ffffff'}));
        res.json({colors:final});
    } catch(err){console.error('[Palette]',err.message);res.status(500).json({error:err.message});}
});

// ── TOOL 7: EXIF Remover ──
app.post('/exif-remove', upload.fields([{name:'images',maxCount:500}]), async (req,res) => {
    try {
        const jobId=req.body.jobId||'exif', format=req.body.format||'same', quality=parseInt(req.body.quality||92);
        const images=req.files['images']||[];
        if(!images.length) return res.status(400).json({error:'No images.'});
        const archive=zipResponse(res,'clean_images.zip');
        for(let i=0;i<images.length;i++){
            const file=images[i];
            sendProgress(jobId,{current:i+1,total:images.length,filename:file.originalname,percent:Math.round((i/images.length)*100)});
            const meta=await sharp(file.buffer).metadata();
            const outFmt=format==='same'?(meta.format==='jpeg'?'jpeg':meta.format||'jpeg'):format;
            const ext=outFmt==='jpeg'?'jpg':outFmt, outName=path.parse(file.originalname).name+'_clean.'+ext;
            const fmtOpts=outFmt==='png'?{compressionLevel:6}:{quality};
            const outBuf=await sharp(file.buffer).toFormat(outFmt,fmtOpts).toBuffer(); // no withMetadata = strips EXIF
            archive.append(outBuf,{name:outName});
        }
        sendProgress(jobId,{done:true,total:images.length});
        await archive.finalize();
    } catch(err){console.error('[EXIF]',err.message);if(!res.headersSent) res.status(500).json({error:err.message});}
});

// ── TOOL 8: ZIP Image Processor ──
app.post('/zip-process', single.single('zipfile'), async (req,res) => {
    try {
        if(!req.file) return res.status(400).json({error:'No ZIP file uploaded.'});
        const targetW=parseInt(req.body.width||1080), targetH=parseInt(req.body.height||1080);
        const format=req.body.format||'webp', quality=parseInt(req.body.quality||90), fitMode=req.body.fitMode||'contain', bgColor=hexToRgba(req.body.bgColor);
        const zip=new AdmZip(req.file.buffer);
        const entries=zip.getEntries().filter(e=>!e.isDirectory&&/\.(jpe?g|png|webp)$/i.test(e.entryName));
        if(!entries.length) return res.status(400).json({error:'No images found in ZIP.'});
        const archive=zipResponse(res,'processed_from_zip.zip');
        const ext=format==='jpeg'?'jpg':format;
        const fmtOpts=format==='png'?{compressionLevel:6}:{quality};
        for(const entry of entries){
            const buf=entry.getData(), outName=path.parse(entry.entryName).name+'.'+ext;
            const outBuf=await sharp(buf).resize({width:targetW,height:targetH,fit:fitMode,background:bgColor}).toFormat(format,fmtOpts).toBuffer();
            archive.append(outBuf,{name:outName});
        }
        await archive.finalize();
    } catch(err){console.error('[ZIP]',err.message);if(!res.headersSent) res.status(500).json({error:err.message});}
});

module.exports = app;
if(require.main===module) app.listen(3000,()=>console.log('🚀 ImagePipeline Hub on http://localhost:3000'));
