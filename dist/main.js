"use strict";
var __rest = (this && this.__rest) || function (s, e) {
    var t = {};
    for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
        t[p] = s[p];
    if (s != null && typeof Object.getOwnPropertySymbols === "function")
        for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
            if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
                t[p[i]] = s[p[i]];
        }
    return t;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.S3Storage = void 0;
const rxjs_1 = require("rxjs");
const operators_1 = require("rxjs/operators");
const sharp = require("sharp");
const mime_types_1 = require("mime-types");
const stream_1 = require("stream");
const get_sharp_options_1 = require("./get-sharp-options");
const transformer_1 = require("./transformer");
const get_filename_1 = require("./get-filename");
class S3Storage {
    constructor(options) {
        if (!options.s3) {
            throw new Error('You have to specify s3 for AWS S3 to work.');
        }
        this.opts = Object.assign(Object.assign({}, S3Storage.defaultOptions), options);
        this.sharpOpts = (0, get_sharp_options_1.default)(options);
        if (!this.opts.Bucket) {
            throw new Error('You have to specify Bucket for AWS S3 to work.');
        }
        if (typeof this.opts.Key !== 'string') {
            if (typeof this.opts.Key !== 'function') {
                throw new TypeError(`Key must be a "string" or "function" or "undefined" but got ${typeof this
                    .opts.Key}`);
            }
        }
    }
    _handleFile(req, file, cb) {
        const { opts, sharpOpts } = this;
        const { mimetype, stream } = file;
        const params = {
            Bucket: opts.Bucket,
            ACL: opts.ACL,
            CacheControl: opts.CacheControl,
            ContentType: opts.ContentType,
            Metadata: opts.Metadata,
            StorageClass: opts.StorageClass,
            ServerSideEncryption: opts.ServerSideEncryption,
            SSEKMSKeyId: opts.SSEKMSKeyId,
            Body: stream,
            Key: opts.Key,
        };
        if (typeof opts._resize === 'function') {
            this.opts.resize = opts._resize(req);
        }
        if (typeof opts.Key === 'function') {
            opts.Key(req, file, (fileErr, Key) => {
                if (fileErr) {
                    cb(fileErr);
                    return;
                }
                params.Key = Key;
                if (mimetype.includes('image')) {
                    this._uploadProcess(params, file, cb);
                }
                else {
                    this._uploadNonImage(params, file, cb);
                }
            });
        }
        else {
            if (mimetype.includes('image')) {
                this._uploadProcess(params, file, cb);
            }
            else {
                this._uploadNonImage(params, file, cb);
            }
        }
    }
    _removeFile(req, file, cb) {
        this.opts.s3.deleteObject({ Bucket: file.Bucket, Key: file.Key }, cb);
    }
    _uploadProcess(params, file, cb) {
        const { opts, sharpOpts } = this;
        let { stream, mimetype } = file;
        const { ACL, ContentDisposition, ContentType: optsContentType, StorageClass, ServerSideEncryption, Metadata, } = opts;
        if (opts.multiple && Array.isArray(opts.resize) && opts.resize.length > 0) {
            const sizes = (0, rxjs_1.from)(opts.resize);
            sizes
                .pipe((0, operators_1.map)((size) => {
                const resizerStream = (0, transformer_1.default)(sharpOpts, size);
                if (size.suffix === 'original') {
                    size.Body = stream.pipe(sharp({ animated: true }).clone());
                }
                else {
                    if (mimetype.includes('gif') || mimetype.includes('webp'))
                        size.Body = stream.pipe(sharp({ animated: true }).clone());
                    else
                        size.Body = stream.pipe(resizerStream.clone());
                }
                return size;
            }), (0, operators_1.mergeMap)((size) => {
                const meta = { stream: size.Body };
                const getMetaFromSharp = meta.stream.toBuffer({
                    resolveWithObject: true,
                });
                return (0, rxjs_1.from)(getMetaFromSharp.then((result) => {
                    return Object.assign(Object.assign(Object.assign({}, size), result.info), { ContentType: result.info.format, currentSize: result.info.size });
                }));
            }), (0, operators_1.mergeMap)((size) => {
                const { Body, ContentType } = size;
                const streamCopy = new stream_1.PassThrough();
                const keyDot = params.Key.split('.');
                let key = `${params.Key}-${size.suffix}`;
                if (keyDot.length > 1) {
                    keyDot.pop();
                    key = `${keyDot.join('.')}-${size.suffix}.${params.Key.split('.')[keyDot.length]}`;
                }
                let newParams = Object.assign(Object.assign({}, params), { Body,
                    ContentType, Key: size.directory ? `${size.directory}/${key}` : key });
                const upload = opts.s3.upload(newParams);
                let currentSize = { [size.suffix]: 0 };
                upload.on('httpUploadProgress', function (ev) {
                    if (ev.total) {
                        currentSize[size.suffix] = ev.total;
                    }
                });
                const upload$ = (0, rxjs_1.from)(upload.promise().then((result) => {
                    // tslint:disable-next-line
                    const { Body } = size, rest = __rest(size, ["Body"]);
                    return Object.assign(Object.assign(Object.assign({}, result), rest), { currentSize: size.currentSize || currentSize[size.suffix] });
                }));
                return upload$;
            }), (0, operators_1.toArray)())
                .subscribe((res) => {
                const mapArrayToObject = res.reduce((acc, curr) => {
                    // tslint:disable-next-line
                    const { suffix, ContentType, size, format, channels, options, currentSize } = curr, rest = __rest(curr, ["suffix", "ContentType", "size", "format", "channels", "options", "currentSize"]);
                    acc[curr.suffix] = Object.assign(Object.assign({ ACL,
                        ContentDisposition,
                        StorageClass,
                        ServerSideEncryption,
                        Metadata }, rest), { size: currentSize, ContentType: optsContentType || ContentType });
                    mimetype = (0, mime_types_1.lookup)(ContentType) || `image/${ContentType}`;
                    return acc;
                }, {});
                mapArrayToObject.mimetype = mimetype;
                cb(null, JSON.parse(JSON.stringify(mapArrayToObject)));
            }, cb);
        }
        else {
            let currentSize = 0;
            const resizerStream = (0, transformer_1.default)(sharpOpts, sharpOpts.resize);
            let newParams = Object.assign(Object.assign({}, params), { Body: stream.pipe(resizerStream) });
            const meta = { stream: newParams.Body };
            const meta$ = (0, rxjs_1.from)(meta.stream.toBuffer({
                resolveWithObject: true,
            }));
            meta$
                .pipe((0, operators_1.map)((metadata) => {
                newParams.ContentType = opts.ContentType || metadata.info.format;
                return metadata;
            }), (0, operators_1.mergeMap)((metadata) => {
                const upload = opts.s3.upload(newParams);
                upload.on('httpUploadProgress', function (ev) {
                    if (ev.total) {
                        currentSize = ev.total;
                    }
                });
                const upload$ = (0, rxjs_1.from)(upload.promise().then((res) => {
                    return Object.assign(Object.assign({}, res), metadata.info);
                }));
                return upload$;
            }))
                .subscribe((result) => {
                // tslint:disable-next-line
                const { size, format, channels } = result, rest = __rest(result, ["size", "format", "channels"]);
                const endRes = Object.assign(Object.assign({ ACL,
                    ContentDisposition,
                    StorageClass,
                    ServerSideEncryption,
                    Metadata }, rest), { size: currentSize || size, ContentType: opts.ContentType || format, mimetype: (0, mime_types_1.lookup)(result.format) || `image/${result.format}` });
                cb(null, JSON.parse(JSON.stringify(endRes)));
            }, cb);
        }
    }
    _uploadNonImage(params, file, cb) {
        const { opts } = this;
        const { mimetype } = file;
        let currentSize = 0;
        params.ContentType = params.ContentType || mimetype;
        const upload = opts.s3.upload(params);
        upload.on('httpUploadProgress', function (ev) {
            if (ev.total) {
                currentSize = ev.total;
            }
        });
        upload.promise().then((result) => {
            const endRes = Object.assign({ size: currentSize, ACL: opts.ACL, ContentType: opts.ContentType || mimetype, ContentDisposition: opts.ContentDisposition, StorageClass: opts.StorageClass, ServerSideEncryption: opts.ServerSideEncryption, Metadata: opts.Metadata }, result);
            cb(null, JSON.parse(JSON.stringify(endRes)));
        }, cb);
    }
}
exports.S3Storage = S3Storage;
S3Storage.defaultOptions = {
    ACL: process.env.AWS_ACL || 'public-read',
    Bucket: process.env.AWS_BUCKET || null,
    Key: get_filename_1.default,
    multiple: false,
    multipart: true, // Enable multipart uploads
};
function s3Storage(options) {
    return new S3Storage(options);
}
exports.default = s3Storage;
//# sourceMappingURL=main.js.map