import alt from '../alt';

class SideBarActions {
    constructor () {
        this.generateActions(
            'getProjectsSuccess',
            'getProjectsFail'
        )
    }
    
    getProjects() {
        $.ajax({
            url: '/api/projects',
            dataType: 'json',
            cache: false
        }).done((data) => {
            this.getProjectsSuccess(data);
        }).fail((jqXhr) => {
            this.getProjectsFail(jqXhr);
        });
        return false;
    }
}

export default alt.createActions(SideBarActions);