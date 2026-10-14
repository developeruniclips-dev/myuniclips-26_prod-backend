'use strict';
const {logError}=require('../utils/safeLogging');
const PARSER_ERRORS=new Map([
 ['entity.too.large',[413,'Request body is too large','REQUEST_TOO_LARGE']],
 ['entity.parse.failed',[400,'Invalid JSON body','INVALID_JSON']],
 ['encoding.unsupported',[415,'Unsupported body encoding','UNSUPPORTED_ENCODING']],
 ['request.aborted',[400,'Request was interrupted','REQUEST_INTERRUPTED']]
]);
function publicError(error){
 const parser=PARSER_ERRORS.get(error?.type);if(parser)return{status:parser[0],body:{error:parser[1],code:parser[2]}};
 const raw=error?.statusCode??error?.status;
 const status=Number.isInteger(raw)&&raw>=400&&raw<=599?raw:500;
 return{status,body:{error:status>=500?'An internal server error occurred':'Unable to complete this request',code:status===503?'SERVICE_UNAVAILABLE':status>=500?'INTERNAL_ERROR':'REQUEST_REJECTED'}};
}
function errorHandler(error,req,res,next){
 logError('Request handling failed',error);
 if(res.headersSent){const safe=new Error('Request handling failed');safe.stack=undefined;return next(safe);}
 const safe=publicError(error);return res.status(safe.status).json(safe.body);
}
module.exports={publicError,errorHandler};
