const pveapi = require('./source')
const yaml = require('js-yaml')

const paths = {}
const models = {}
const responses = {}
const tags = []

const capitalizeFirst = (str) => str.charAt(0).toUpperCase() + str.slice(1)

function generateOpId(method, path){
    let operation = path.split("/").map(capitalizeFirst).join('').replace(/[\-\_]/g, '')

    operation = operation.replace(/\{[a-z]*\}/g, 'Single')

    const prefix = (() => {
        switch (method) {
            case "post":
                return "create"
            case "put":
                return "update"
            case "patch":
                return "update"
            default:
                return method
        }
    })()

    return prefix + operation
}

const mapping = require('./mapping')

function filterSchema(p){
    const schema = {
        type: p.type
    }
    if(p.items)
        schema.items = filterSchema(p.items)
    if(p.properties){
        schema.properties = {}
        Object.keys(p.properties).forEach(name => schema.properties[name] = filterSchema(p.properties[name]))
    }
    return schema
}

function buildResponseSchema(source){
    const schema = { type: source.type || 'string', description: source.description || '' }
    if(schema.type === 'null')
        schema.type = 'string'
    if(source.type === 'array' && source.items)
        schema.items = buildResponseSchema(source.items)
    if(source.type === 'object' && source.properties){
        schema.properties = {}
        Object.keys(source.properties || {}).forEach(k => {
            if(k.endsWith('[n]')){
                const nk = k.substr(0, k.length-3)
                for(let i=0; i<30; i++){
                    schema.properties[nk+i] = buildResponseSchema(source.properties[k])
                }
            }else{
                schema.properties[k] = buildResponseSchema(source.properties[k])
            }
        })
    }
    return schema
}

function parseInfo(path, method, info){
    let id = generateOpId(method, path);
    id = mapping[id] || id
    let properties = (info.parameters && info.parameters.properties) ? Object.keys(info.parameters.properties).map(k => ({ name: k, ...info.parameters.properties[k] })) : []

    properties = properties.map(p => {
        if(p.type === 'string' && p.name.endsWith('[n]')){
            p.items = JSON.parse(JSON.stringify(p))
            p.type = 'array';
            p.name = p.name.substr(0, p.name.length-3);
        }
        return p;
    });

    const requestName = capitalizeFirst(id) + 'Request'
    const responseName = capitalizeFirst(id) + 'Response'
    
    paths[path][method] = {
        operationId: id,
        summary: id,
        description: info.description || id,
        tags: [path.substr(1).split('/')[0]],
        parameters: properties.filter(p => path.includes('{'+p.name+'}')).map(p => ({ name: p.name, in: 'path', required: true, description: p.name, schema: { type: p.type } })),
        responses: {
            '200': {
                $ref: '#/components/responses/'+responseName
            }
        }
    }

    paths[path][method].tags.forEach(t => {
        if(!tags.includes(t))
            tags.push(t)
    })

    responses[responseName] = {
        description: responseName,
        content: {
            'application/json': {
                schema: {
                    type: 'object',
                    properties: {
                        errors: {
                            type: 'array',
                            items: {
                                type: 'string'
                            }
                        },
                        data: buildResponseSchema(info.returns)
                    }
                }
            }
        }
    }

    if(method === 'post' || method === 'put'){
        models[requestName] = {
            title: requestName, 
            type: 'object',
            properties: {},
            required: []
        }
        properties.filter(p => !path.includes('{'+p.name+'}')).forEach(p => {
            models[requestName].properties[p.name] = filterSchema(p)
            if(p.optional !== 1){
                models[requestName].required.push(p.name)
            }
        })
        if(models[requestName].required.length < 1)
            delete models[requestName].required
        paths[path][method].requestBody = {
            content: {
                'application/json': {
                    schema: {
                        $ref: '#/components/schemas/'+requestName
                    }
                }
            }
        }
    }else{
        properties.filter(p => !path.includes('{'+p.name+'}')).map(p => ({ name: p.name, in: 'query', required: p.optional !== 1, description: p.name, schema: { type: p.type } }))
    }
}

function parsePath(source){
    if(source.info && Object.keys(source.info).length > 0){
        paths[source.path] = {}
        Object.keys(source.info).forEach(method => parseInfo(source.path, method.toLowerCase(), source.info[method]))
    }
    if(source.children)
        source.children.forEach(parsePath)
}

pveapi.forEach(parsePath)

const spec = {
    openapi: '3.0.0',
    info: {
        title: 'ProxMox VE API',
        version: '2.0',
        description: 'ProxMox VE API',
        contact: {
            name: 'LUMASERV Support Team',
            email: 'support@lumaserv.com'
        }
    },
    servers: [
        {
            description: 'local',
            url: 'https://cluster.local:8006/api2/json'
        }
    ],
    tags: tags.map(t => ({ name: t })),
    paths: paths,
    components: {
        schemas: models,
        responses: responses
    }
}

const fs = require('fs')

fs.writeFileSync('../reference/spec.v2.yaml', yaml.safeDump(spec))
